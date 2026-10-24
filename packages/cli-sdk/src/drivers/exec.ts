/**
 * exec 会话驱动：每轮起一个进程（`codex exec --json`、`grok -p`、dsh），按行解析输出，进程结束即本轮结束。
 * 长驻协议起不来时的退路，也是 dsh 的主路径。续接靠插件在参数里带上一轮的会话 id。
 */
import { randomUUID } from 'node:crypto';

import type { ChildLike, KillFn, SpawnFn } from '../child';
import {
  EventHub,
  appendText,
  type SessionDriver,
  type StartResult,
  type TurnInput,
  type TurnResult,
} from '../driver';
import type { HarnessEvent, PermissionAnswer, SessionEvent } from '../events';

export interface ExecDriverOptions {
  spawn: SpawnFn;
  command: string;
  cwd: string;
  /** 这一轮的参数（会话 id 为 null 表示新会话） */
  args: (input: TurnInput, sessionId: string | null) => string[];
  /** 每轮新建一个行解析器（带跨行状态） */
  parser: () => (line: string) => HarnessEvent[];
  /** 提示词走 stdin 时给出要写的内容；不给则只关 stdin */
  stdin?: (input: TurnInput) => string | null;
  /** 续接的会话 id */
  resumeId?: string | null;
  kill?: KillFn;
  newId?: () => string;
  /** 退出码非 0 且没有正文时的错误文案 */
  exitMessage?: (code: number | null) => string;
  /**
   * 插件给的「整轮完成」规则（ExecRules.completes）。给了就按严格规则收尾：
   * - 没见过完成事件就被停止 / 被信号杀死 → 失败（不能因为已有部分文字就当成功）；
   * - 见过完成事件之后，收尾阶段的非零退出不再翻案为失败；
   * - 报了错、一个字也没回 → 失败。
   * 不给则沿用宽松规则（停止时有文字算 cancelled）。
   */
  completes?: (ev: HarnessEvent) => boolean;
  /** 没有任何事件就以 0 退出时的错误（返回 null = 正常）；插件声明 silentExitIsError 时宿主给出文案 */
  silentExit?: () => string | null;
  /** stdin 保持打开，见到 done 再 EOF（仅特殊 mock 需要；多数 CLI 必须立刻 EOF） */
  keepStdin?: boolean;
  /** 宿主侧的「用户要求停止」（宿主自己杀进程时，driver 据此判定中止） */
  stopRequested?: () => boolean;
  /** 被中止时的错误文案 */
  abortedMessage?: string;
  onStderr?: (chunk: string) => void;
}

export class ExecDriver implements SessionDriver {
  private readonly hub = new EventHub<SessionEvent>();
  private child: ChildLike | null = null;
  private sid: string | null;
  private ended = false;
  private stopped = false;

  constructor(private readonly o: ExecDriverOptions) {
    this.sid = o.resumeId ?? null;
  }

  get events(): AsyncIterable<SessionEvent> {
    return this.hub;
  }

  on(fn: (e: SessionEvent) => void): () => void {
    return this.hub.on(fn);
  }

  get sessionId(): string | null {
    return this.sid;
  }

  get closed(): boolean {
    return this.ended;
  }

  get inTurn(): boolean {
    return this.child !== null;
  }

  async start(): Promise<StartResult> {
    return { sessionId: this.sid, capabilities: { loadSession: true } };
  }

  send(input: TurnInput): Promise<TurnResult> {
    if (this.ended) return Promise.reject(new Error('driver closed'));
    if (this.child) return Promise.reject(new Error('previous turn still running'));
    const turnId = (this.o.newId ?? randomUUID)();
    const parse = this.o.parser();
    const child = this.o.spawn(this.o.command, this.o.args(input, this.sid), { cwd: this.o.cwd });
    this.child = child;
    this.stopped = false;
    const onAbort = () => void this.interrupt();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    return new Promise<TurnResult>((resolve, reject) => {
      let buf = '';
      let text = '';
      let lastError: string | null = null;
      let usage: TurnResult['usage'];
      let settled = false;
      let completed = false;
      let count = 0;
      const strict = !!this.o.completes;
      const handle = (line: string, tail = false) => {
        if (!line.trim()) return;
        for (const ev of parse(line)) {
          count++;
          text = appendText(text, ev);
          if (ev.type === 'error') lastError = ev.message;
          if (this.o.completes?.(ev)) completed = true;
          if (ev.type === 'done') {
            if (ev.sessionId) this.sid = ev.sessionId;
            if (ev.usage) usage = ev.usage;
            if (!text && ev.text) text = ev.text;
            // 一轮结束：仍开着 stdin 就补 EOF，避免 CLI 空等
            if (this.o.keepStdin)
              try {
                child.stdin.end();
              } catch {
                /* */
              }
          }
          if (ev.type === 'permission')
            this.hub.emit({
              kind: 'permission',
              id: ev.id,
              request: { summary: ev.summary },
              turnId,
            });
          this.hub.emit({ kind: 'harness', event: ev, turnId, ...(tail ? { tail: true } : {}) });
        }
      };
      child.stdout.on('data', (c) => {
        buf += typeof c === 'string' ? c : c.toString('utf8');
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? '';
        for (const line of parts) handle(line);
      });
      child.stderr.on('data', (c) =>
        this.o.onStderr?.(typeof c === 'string' ? c : c.toString('utf8')),
      );
      const finish = (code: number | null, err: Error | null, signal: string | null = null) => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener('abort', onAbort);
        if (this.child === child) this.child = null;
        // 最后一行没有换行：收尾时才解析（不算实时输出）
        if (buf.trim()) handle(buf, true);
        buf = '';
        if (err) return reject(err);
        const aborted = new Error(this.o.abortedMessage ?? 'aborted');
        if (strict) {
          if (!completed && (this.stopped || this.o.stopRequested?.() || signal))
            return reject(aborted);
          const silent = count === 0 && !code ? (this.o.silentExit?.() ?? null) : null;
          if (silent) return reject(new Error(silent));
          if (code && !completed)
            return reject(
              new Error(lastError ?? this.o.exitMessage?.(code) ?? `exit code ${code}`),
            );
          if (lastError && !text.trim()) return reject(new Error(lastError));
          return resolve({
            turnId,
            stopReason: 'end_turn',
            text,
            sessionId: this.sid,
            ...(usage ? { usage } : {}),
          });
        }
        if (this.stopped && !text) return reject(aborted);
        if (code && code !== 0 && !text)
          return reject(new Error(lastError ?? this.o.exitMessage?.(code) ?? `exit code ${code}`));
        resolve({
          turnId,
          stopReason: this.stopped ? 'cancelled' : code ? 'exited' : 'end_turn',
          text,
          sessionId: this.sid,
          ...(usage ? { usage } : {}),
          ...(lastError && !text ? { error: lastError } : {}),
        });
      };
      child.on('error', (e) => finish(null, e));
      child.on('close', (code, signal) => finish(code, null, signal ?? null));
      try {
        const data = this.o.stdin?.(input);
        if (data) child.stdin.write(data);
        if (!this.o.keepStdin) child.stdin.end();
      } catch {
        /* 进程已退出：close 事件给结果 */
      }
    });
  }

  async interrupt(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopped = true;
    try {
      if (!child.killed && child.exitCode === null) (this.o.kill ?? ((c) => c.kill()))(child);
    } catch {
      /* */
    }
  }

  /** exec 协议没有交互式确认（权限由启动参数决定） */
  respondPermission(_id: string, _answer: PermissionAnswer): boolean {
    return false;
  }

  async close(): Promise<void> {
    await this.interrupt();
    this.ended = true;
    this.hub.end();
  }
}
