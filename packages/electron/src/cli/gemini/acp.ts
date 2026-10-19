/**
 * ACP（Agent Client Protocol）客户端：stdio 上换行分隔的 JSON-RPC 2.0（Gemini CLI 0.62.0 `--acp` 实测）。
 * 只做传输：发请求 / 通知、收通知、应答代理发来的请求（如 session/request_permission）。
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { t } from '../../i18n';

type Json = Record<string, unknown>;

/** 普通请求（initialize / session/new …）默认等多久：Gemini 加载 MCP、刷新令牌也用不了这么久 */
export const ACP_REQUEST_TIMEOUT_MS = 120_000;

export interface AcpRequestOptions {
  /** 超时（毫秒）；0 = 不限。默认 ACP_REQUEST_TIMEOUT_MS */
  timeoutMs?: number;
  /**
   * 按「没有动静」计时：代理每发来一条消息就重新计时；代理在等我们应答（如权限确认）时暂停计时。
   * 用于 session/prompt 这种可能跑很久、但一直在输出的请求。
   */
  idle?: boolean;
  /** 超时后调用（如发 session/cancel 让代理停下这一轮） */
  onTimeout?: () => void;
  /** 调用方主动取消 */
  signal?: AbortSignal;
}

export class AcpTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(
      t(
        'Gemini 响应超时（{0} 秒没有响应），已取消这次请求。请重试，若反复出现请检查网络或重启该会话。',
        Math.round(timeoutMs / 1000),
      ),
    );
    this.name = 'AcpTimeoutError';
  }
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

export class AcpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'AcpError';
  }
}

/**
 * Gemini 把上游错误层层包成 JSON 字符串放进 message（`{"error":{"message":"{\n \"error\": {...}}"}}`）：
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

export class AcpConnection {
  private seq = 0;
  private buf = '';
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  /** 代理发来、我们还没应答的请求数（> 0 时 idle 计时暂停） */
  private inbound = 0;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: {
      onNotification: (method: string, params: Json) => void;
      /** 代理发来的请求：返回 result（或抛错 → JSON-RPC error） */
      onRequest: (method: string, params: Json) => Promise<unknown>;
    },
  ) {
    child.stdout.on('data', (c: Buffer) => this.onData(c));
    child.on('close', () => this.fail(new Error('ACP process exited')));
    child.on('error', (e) => this.fail(e));
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
      p.reject(new AcpTimeoutError(p.method, p.timeoutMs));
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

  private onData(chunk: Buffer) {
    this.buf += chunk.toString('utf8');
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    for (const line of lines) {
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
        p.reject(new AcpError(err.code ?? -1, innermostMessage(String(err.message ?? 'error'))));
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

  request<T = unknown>(method: string, params: Json, opts: AcpRequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ACP connection closed'));
    if (opts.signal?.aborted) return Promise.reject(new Error('ACP request aborted'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutMs: opts.timeoutMs ?? ACP_REQUEST_TIMEOUT_MS,
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
