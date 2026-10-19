/**
 * ACP（Agent Client Protocol）客户端：stdio 上换行分隔的 JSON-RPC 2.0（Gemini CLI 0.62.0 `--acp` 实测）。
 * 只做传输：发请求 / 通知、收通知、应答代理发来的请求（如 session/request_permission）。
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

type Json = Record<string, unknown>;

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
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private closed = false;

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
    if (typeof msg.method === 'string') {
      const params = (msg.params ?? {}) as Json;
      if (id === undefined || id === null) {
        this.handlers.onNotification(msg.method, params);
        return;
      }
      void this.handlers.onRequest(msg.method, params).then(
        (result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }),
        (e: unknown) =>
          this.write({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
          }),
      );
      return;
    }
    if (typeof id === 'number') {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
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

  request<T = unknown>(method: string, params: Json): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ACP connection closed'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      if (!this.write({ jsonrpc: '2.0', id, method, params })) {
        this.pending.delete(id);
        reject(new Error('ACP stdin not writable'));
      }
    });
  }

  notify(method: string, params: Json): boolean {
    return this.write({ jsonrpc: '2.0', method, params });
  }

  private fail(e: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  get isClosed() {
    return this.closed;
  }
}
