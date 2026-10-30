/**
 * stream-json 会话驱动（Claude Code `--input-format stream-json --output-format stream-json`）。
 *
 * 进程由宿主带好参数拉起（--resume、权限、模型都在启动参数里），驱动负责：
 * - 按行切 stdout，交给插件的行解析器（parseLine → HarnessEvent）；
 * - 用户消息：`{type:'user', uuid, message}`；轮次以解析器给出的 done / error 结束；
 * - control_request ↔ control_response：我们发的（interrupt、set_permission_mode、set_model）按 request_id
 *   等应答；CLI 发来的 can_use_tool 变成权限事件，应答写回 control_response（允许 / 拒绝 / 改写入参）。
 * 编排层还需要看原始行（回显、后台任务）时用 onLine 钩子；返回 true 表示该行已处理、不再解析。
 */
import { randomUUID } from 'node:crypto';

import { endChild, type ChildLike, type KillFn } from '../child';
import {
  EventHub,
  appendText,
  type SessionDriver,
  type StartResult,
  type TurnInput,
  type TurnResult,
} from '../driver';
import type { HarnessEvent, PermissionAnswer, SessionEvent } from '../events';
import { LineSplitter } from '../lines';

/** control_request 等应答的上限 */
export const CONTROL_TIMEOUT_MS = 10_000;

export interface StreamJsonDriverOptions {
  child: ChildLike;
  /** 一行 → 事件（插件的解析器，带自己的跨行状态） */
  parseLine: (line: string) => HarnessEvent[];
  /**
   * 原始行钩子：返回 true 表示已处理（回显、后台任务等编排层自己管的行）。
   * final = 进程退出时缓冲区里剩下的最后半行（编排层可以选择不实时推给界面）
   */
  onLine?: (line: string, o: { final: boolean }) => boolean;
  /** 错误文案（宿主本地化） */
  messages?: { timeout?: string; notWritable?: string; exited?: string; rejected?: string };
  controlTimeoutMs?: number;
  /** 拒绝时给 CLI 的理由（宿主本地化） */
  denyMessage?: string;
  /** 续接的会话 id（启动参数里已带 --resume） */
  resumeId?: string | null;
  kill?: KillFn;
  newId?: () => string;
}

interface ControlWaiter {
  resolve: (r: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StreamTurn {
  id: string;
  text: string;
  sessionId: string | null;
  usage?: TurnResult['usage'];
  lastError: string | null;
  settled: boolean;
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
}

export class StreamJsonDriver implements SessionDriver {
  private readonly hub = new EventHub<SessionEvent>();
  private readonly controls = new Map<string, ControlWaiter>();
  /** CLI 发来、还没应答的 can_use_tool：request_id → 是否仍在等 */
  private readonly asks = new Set<string>();
  private readonly lines = new LineSplitter();
  private turn: StreamTurn | null = null;
  private sid: string | null;
  private exited = false;

  constructor(private readonly o: StreamJsonDriverOptions) {
    this.sid = o.resumeId ?? null;
    o.child.stdout.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of this.lines.push(text)) this.onLine(line, false);
    });
    o.child.on('error', (e) => this.onExit(null, e));
    o.child.on('close', (code) => {
      const rest = this.lines.take();
      if (rest.trim()) this.onLine(rest, true);
      this.onExit(code, null);
    });
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
    return this.exited;
  }

  get inTurn(): boolean {
    return this.turn !== null;
  }

  private onExit(code: number | null, err: Error | null) {
    if (this.exited) return;
    this.exited = true;
    this.failControls(err ?? new Error(this.o.messages?.exited ?? 'process exited'));
    this.asks.clear();
    const turn = this.turn;
    this.turn = null;
    if (turn && !turn.settled) {
      turn.settled = true;
      if (err) turn.reject(err);
      else if (code && code !== 0 && !turn.text)
        turn.reject(new Error(turn.lastError ?? `exit code ${code}`));
      else
        turn.resolve({
          turnId: turn.id,
          stopReason: code ? 'exited' : 'end_turn',
          text: turn.text,
          sessionId: turn.sessionId ?? this.sid,
        });
    }
    this.hub.emit({ kind: 'health', state: 'exited', code });
    this.hub.end();
  }

  private onLine(line: string, final: boolean) {
    if (!line.trim()) return;
    if (line.includes('"control_response"') && this.onControlResponse(line)) return;
    if (this.o.onLine?.(line, { final })) return;
    const turn = this.turn;
    for (const ev of this.o.parseLine(line)) {
      if (ev.type === 'permission') {
        this.asks.add(ev.id);
        this.hub.emit({
          kind: 'permission',
          id: ev.id,
          request: { summary: ev.summary, ...(ev.toolUseId ? { toolUseId: ev.toolUseId } : {}) },
          ...(turn ? { turnId: turn.id } : {}),
        });
      }
      if (turn) {
        turn.text = appendText(turn.text, ev);
        if (ev.type === 'error') turn.lastError = ev.message;
      }
      this.hub.emit({ kind: 'harness', event: ev, ...(turn ? { turnId: turn.id } : {}) });
      if (ev.type === 'done') {
        if (ev.sessionId) this.sid = ev.sessionId;
        if (turn && !turn.settled) {
          turn.settled = true;
          this.turn = null;
          turn.resolve({
            turnId: turn.id,
            stopReason: 'end_turn',
            text: turn.text || ev.text,
            sessionId: ev.sessionId ?? this.sid,
            ...(ev.usage ? { usage: ev.usage } : {}),
          });
        }
      }
    }
  }

  private onControlResponse(line: string): boolean {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (j.type !== 'control_response') return false;
    const r = (j.response ?? {}) as Record<string, unknown>;
    const requestId = typeof r.request_id === 'string' ? r.request_id : '';
    const w = this.controls.get(requestId);
    if (!w) return true;
    this.controls.delete(requestId);
    clearTimeout(w.timer);
    if (r.subtype === 'success') w.resolve((r.response ?? {}) as Record<string, unknown>);
    else
      w.reject(
        new Error(
          typeof r.error === 'string' && r.error
            ? r.error
            : (this.o.messages?.rejected ?? 'request rejected'),
        ),
      );
    return true;
  }

  private write(obj: unknown): boolean {
    if (this.exited || !this.o.child.stdin.writable) return false;
    try {
      this.o.child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** 发 control_request 并等同 request_id 的 control_response；负确认 / 超时 / 写不进去都会 reject */
  control(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = (this.o.newId ?? randomUUID)();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(requestId);
        reject(new Error(this.o.messages?.timeout ?? 'control request timed out'));
      }, this.o.controlTimeoutMs ?? CONTROL_TIMEOUT_MS);
      timer.unref?.();
      this.controls.set(requestId, { resolve, reject, timer });
      if (!this.write({ type: 'control_request', request_id: requestId, request })) {
        clearTimeout(timer);
        this.controls.delete(requestId);
        reject(new Error(this.o.messages?.notWritable ?? 'stdin not writable'));
      }
    });
  }

  /** 发 control_request 不等应答（如 stop_task）；写不进去返回 false */
  notifyControl(request: Record<string, unknown>): boolean {
    return this.write({
      type: 'control_request',
      request_id: (this.o.newId ?? randomUUID)(),
      request,
    });
  }

  private failControls(e: Error) {
    for (const w of this.controls.values()) {
      clearTimeout(w.timer);
      w.reject(e);
    }
    this.controls.clear();
  }

  async start(): Promise<StartResult> {
    // stream-json 没有握手：进程起来就能收消息；会话 id 在第一轮的 init / result 里
    return { sessionId: this.sid, capabilities: { images: true } };
  }

  /** 写一条用户消息（不等结果）；send() 在它之上等本轮结束 */
  writeUser(content: unknown, uuid: string = (this.o.newId ?? randomUUID)()): boolean {
    return this.write({ type: 'user', uuid, message: { role: 'user', content } });
  }

  send(input: TurnInput): Promise<TurnResult> {
    if (this.turn) return Promise.reject(new Error('previous turn still running'));
    return new Promise<TurnResult>((resolve, reject) => {
      const turn: StreamTurn = {
        id: (this.o.newId ?? randomUUID)(),
        text: '',
        sessionId: this.sid,
        lastError: null,
        settled: false,
        resolve,
        reject,
      };
      this.turn = turn;
      if (!this.writeUser(input.blocks ?? input.text, turn.id)) {
        this.turn = null;
        reject(new Error('stdin not writable'));
      }
    });
  }

  async interrupt(): Promise<void> {
    await this.control({ subtype: 'interrupt' });
  }

  async setPermissionMode(mode: string): Promise<'applied'> {
    await this.control({ subtype: 'set_permission_mode', mode });
    return 'applied';
  }

  async setModel(model: string | null): Promise<'applied' | 'restart'> {
    await this.control({ subtype: 'set_model', model: model ?? 'default' });
    return 'applied';
  }

  /** can_use_tool 的应答：允许 / 拒绝 / 允许并改写入参 */
  respondPermission(id: string, answer: PermissionAnswer): boolean {
    if (!this.asks.has(id) && !this.o.child.stdin.writable) return false;
    this.asks.delete(id);
    const allow =
      'optionId' in answer ? !/^reject|^deny/.test(answer.optionId) : answer.decision === 'allow';
    const response = allow
      ? 'updatedInput' in answer
        ? { behavior: 'allow', updatedInput: answer.updatedInput }
        : { behavior: 'allow' }
      : { behavior: 'deny', message: this.o.denyMessage ?? 'The user did not allow this call' };
    return this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: id, response },
    });
  }

  async close(): Promise<void> {
    this.failControls(new Error(this.o.messages?.exited ?? 'process exited'));
    endChild(this.o.child, this.o.kill);
  }
}
