/**
 * stdio 上换行分隔的 JSON-RPC 2.0（ACP 与 Codex app-server 共用；原 electron `cli/gemini/acp.ts`）。
 * 只做传输：发请求 / 通知、收通知、应答对端发来的请求（如 session/request_permission）。
 */
import type { ChildLike } from '../child';
import { LineSplitter } from '../lines';

export type Json = Record<string, unknown>;

/** 普通请求（initialize / session/new …）默认等多久：加载 MCP、刷新令牌也用不了这么久 */
export const RPC_REQUEST_TIMEOUT_MS = 120_000;

export interface RpcRequestOptions {
  /** 超时（毫秒）；0 = 不限。默认 RPC_REQUEST_TIMEOUT_MS */
  timeoutMs?: number;
  /**
   * 按「没有动静」计时：对端每发来一条消息就重新计时；对端在等我们应答（如权限确认）时暂停计时。
   * 用于 session/prompt 这种可能跑很久、但一直在输出的请求。
   */
  idle?: boolean;
  /** 超时后调用（如发 session/cancel 让对端停下这一轮） */
  onTimeout?: () => void;
  /** 调用方主动取消 */
  signal?: AbortSignal;
}

export class RpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
    message?: string,
  ) {
    super(message ?? `${method} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'RpcTimeoutError';
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** 进程退出 / 连接关闭时在途请求收到的错误消息（调用方据此判断「握手阶段就退出」） */
export const RPC_EXITED = 'ACP process exited';

/**
 * 上游错误被层层包成 JSON 字符串放进 message（`{"error":{"message":"{\n \"error\": {...}}"}}`）：
 * 一层层解开取最里面的 message，界面才显示得出「API key not valid」这样的原因。
 */
export function innermostMessage(raw: string): string {
  let cur = raw;
  for (let i = 0; i < 6; i++) {
    try {
      const j = JSON.parse(cur) as unknown;
      const next =
        j && typeof j === 'object'
          ? ((j as { error?: { message?: unknown } }).error?.message ??
            (j as { message?: unknown }).message)
          : undefined;
      if (typeof next !== 'string' || next === cur) break;
      cur = next;
    } catch {
      break;
    }
  }
  return cur.trim();
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeoutMs: number;
  idle: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  onTimeout?: () => void;
  cleanup?: () => void;
}

export interface RpcHandlers {
  onNotification: (method: string, params: Json) => void;
  /** 对端发来的请求：返回 result（或抛错 → JSON-RPC error） */
  onRequest: (method: string, params: Json) => Promise<unknown>;
}

export interface RpcConnectionOptions {
  /** 超时错误的文案（宿主做本地化） */
  timeoutMessage?: (method: string, timeoutMs: number) => string;
}

export class JsonRpcConnection {
  private seq = 0;
  private readonly lines = new LineSplitter();
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  /** 对端发来、我们还没应答的请求数（> 0 时 idle 计时暂停） */
  private inbound = 0;

  constructor(
    private readonly child: ChildLike,
    private readonly handlers: RpcHandlers,
    private readonly opts: RpcConnectionOptions = {},
  ) {
    child.stdout.on('data', (c: Buffer | string) => this.onData(c));
    child.on('close', () => this.fail(new Error(RPC_EXITED)));
    child.on('error', (e: Error) => this.fail(e));
    child.stdin.on('error', (e: Error) => this.fail(e));
  }

  private arm(id: number, p: Pending) {
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    if (p.timeoutMs <= 0 || (p.idle && this.inbound > 0)) return;
    p.timer = setTimeout(() => {
      if (this.pending.get(id) !== p) return;
      this.settle(id);
      try {
        p.onTimeout?.();
      } catch {
        /* 尽力而为 */
      }
      p.reject(
        new RpcTimeoutError(
          p.method,
          p.timeoutMs,
          this.opts.timeoutMessage?.(p.method, p.timeoutMs),
        ),
      );
    }, p.timeoutMs);
    // 不让挂起的请求拖住进程退出
    p.timer.unref?.();
  }

  /** 有动静：重新计 idle 请求的时 */
  private touch() {
    for (const [id, p] of this.pending) if (p.idle) this.arm(id, p);
  }

  private settle(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    p.cleanup?.();
    return p;
  }

  private onData(chunk: Buffer | string) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of this.lines.push(text)) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      let msg: Json;
      try {
        msg = JSON.parse(t) as Json;
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Json) {
    const id = msg.id;
    this.touch();
    if (typeof msg.method === 'string') {
      const params = (msg.params ?? {}) as Json;
      if (id === undefined || id === null) {
        this.handlers.onNotification(msg.method, params);
        return;
      }
      this.inbound++;
      this.touch();
      void this.handlers
        .onRequest(msg.method, params)
        .then(
          (result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }),
          (e: unknown) =>
            this.write({
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
            }),
        )
        .finally(() => {
          this.inbound--;
          this.touch();
        });
      return;
    }
    if (typeof id === 'number') {
      const p = this.settle(id);
      if (!p) return;
      const err = msg.error as { code?: number; message?: string } | undefined;
      if (err)
        p.reject(new RpcError(err.code ?? -1, innermostMessage(String(err.message ?? 'error'))));
      else p.resolve(msg.result);
    }
  }

  private write(obj: Json) {
    if (this.closed || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  request<T = unknown>(method: string, params: Json, opts: RpcRequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ACP connection closed'));
    if (opts.signal?.aborted) return Promise.reject(new Error('ACP request aborted'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutMs: opts.timeoutMs ?? RPC_REQUEST_TIMEOUT_MS,
        idle: opts.idle === true,
        timer: null,
        ...(opts.onTimeout ? { onTimeout: opts.onTimeout } : {}),
      };
      if (opts.signal) {
        const signal = opts.signal;
        const onAbort = () => {
          if (this.settle(id)) reject(new Error('ACP request aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        p.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, p);
      if (!this.write({ jsonrpc: '2.0', id, method, params })) {
        this.settle(id);
        reject(new Error('ACP stdin not writable'));
        return;
      }
      this.arm(id, p);
    });
  }

  notify(method: string, params: Json): boolean {
    return this.write({ jsonrpc: '2.0', method, params });
  }

  private fail(e: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(e);
  }

  get isClosed() {
    return this.closed;
  }
}
