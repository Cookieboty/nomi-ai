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
      const handle = (line: string) => {
        if (!line.trim()) return;
        for (const ev of parse(line)) {
          text = appendText(text, ev);
          if (ev.type === 'error') lastError = ev.message;
          if (ev.type === 'done') {
            if (ev.sessionId) this.sid = ev.sessionId;
            if (ev.usage) usage = ev.usage;
            if (!text && ev.text) text = ev.text;
          }
          if (ev.type === 'permission')
            this.hub.emit({
              kind: 'permission',
              id: ev.id,
              request: { summary: ev.summary },
              turnId,
            });
          this.hub.emit({ kind: 'harness', event: ev, turnId });
        }
      };
      child.stdout.on('data', (c) => {
        buf += typeof c === 'string' ? c : c.toString('utf8');
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? '';
        for (const line of parts) handle(line);
      });
      const finish = (code: number | null, err: Error | null) => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener('abort', onAbort);
        if (this.child === child) this.child = null;
        if (buf.trim()) handle(buf);
        buf = '';
        if (err) return reject(err);
        if (this.stopped && !text) return reject(new Error('aborted'));
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
      child.on('close', (code) => finish(code, null));
      try {
        const data = this.o.stdin?.(input);
        if (data) child.stdin.write(data);
        child.stdin.end();
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
