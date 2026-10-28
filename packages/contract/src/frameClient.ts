/**
 * 基于帧的 ClientTransport：只要求底层能「发一帧」和「收帧」，
 * Electron IPC、MessagePort、WebSocket、in-process 都用它，线协议只在这里解释一次（客户端侧）。
 */

import { abortedError, ContractError, fromErrorPayload } from './errors';
import { serverFrameSchema, type ClientFrame, type ServerFrame } from './protocol';
import { PushStream } from './stream';
import type { CallOptions, ClientTransport, ContractLogger } from './transport';

export interface ClientFramePort {
  /** 发一帧；返回 Promise 时，其失败视为发送失败 */
  send(frame: ClientFrame): void | Promise<unknown>;
  /** 收帧；返回取消监听函数 */
  onFrame(fn: (frame: unknown) => void): () => void;
}

export interface FrameClientOptions {
  /** 请求 id 前缀（同一端口上有多个客户端时用来区分，默认随机） */
  idPrefix?: string;
  /** 事件监听器抛错时的处理（默认交给 logger.warn） */
  logger?: ContractLogger;
}

type Pending =
  | { kind: 'call'; resolve: (v: unknown) => void; reject: (e: unknown) => void; cleanup(): void }
  | { kind: 'stream'; stream: PushStream<unknown, unknown>; cleanup(): void };

export function randomId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export interface FrameClientTransport extends ClientTransport {
  close(): void;
}

export function createFrameClientTransport(
  port: ClientFramePort,
  options: FrameClientOptions = {},
): FrameClientTransport {
  const prefix = options.idPrefix ?? randomId().slice(0, 8);
  const pending = new Map<string, Pending>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let seq = 0;
  let closed = false;

  const nextId = (): string => `${prefix}-${(++seq).toString(36)}`;

  const settleError = (id: string, err: unknown): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.cleanup();
    if (p.kind === 'call') p.reject(err);
    else p.stream.fail(err);
  };

  const post = (frame: ClientFrame, id?: string): void => {
    if (closed) return;
    const onFail = (err: unknown) => {
      if (!id) return;
      const message = err instanceof Error ? err.message : String(err);
      settleError(id, new ContractError('TRANSPORT', `Failed to send frame: ${message}`));
    };
    try {
      const r = port.send(frame);
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        (r as Promise<unknown>).catch(onFail);
      }
    } catch (err) {
      onFail(err);
    }
  };

  const handleFrame = (raw: unknown): void => {
    const parsed = serverFrameSchema.safeParse(raw);
    if (!parsed.success) {
      options.logger?.warn('[contract] dropped malformed server frame');
      return;
    }
    const frame: ServerFrame = parsed.data;
    if (frame.t === 'event') {
      const set = listeners.get(frame.event);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(frame.data);
        } catch (err) {
          options.logger?.warn(`[contract] listener for '${frame.event}' threw`, err);
        }
      }
      return;
    }
    const p = pending.get(frame.id);
    if (!p) return; // 已取消 / 已结束的请求的迟到帧
    switch (frame.t) {
      case 'res':
        if (p.kind !== 'call') return;
        pending.delete(frame.id);
        p.cleanup();
        p.resolve(frame.output);
        return;
      case 'chunk':
        if (p.kind === 'stream') p.stream.push(frame.data);
        return;
      case 'end':
        if (p.kind !== 'stream') return;
        pending.delete(frame.id);
        p.cleanup();
        p.stream.end(frame.output);
        return;
      case 'err':
        settleError(frame.id, fromErrorPayload(frame.error));
        return;
    }
  };

  const offPort = port.onFrame(handleFrame);

  const bindAbort = (id: string, signal: AbortSignal | undefined): (() => void) => {
    if (!signal) return () => {};
    const onAbort = () => {
      if (!pending.has(id)) return;
      settleError(id, abortedError());
      post({ t: 'abort', id });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  };

  return {
    call(name: string, input: unknown, opts?: CallOptions): Promise<unknown> {
      if (closed) return Promise.reject(new ContractError('TRANSPORT', 'Transport closed'));
      if (opts?.signal?.aborted) return Promise.reject(abortedError());
      const id = nextId();
      return new Promise((resolve, reject) => {
        pending.set(id, { kind: 'call', resolve, reject, cleanup: () => {} });
        const cleanup = bindAbort(id, opts?.signal);
        const p = pending.get(id);
        if (p) p.cleanup = cleanup;
        post({ t: 'req', id, kind: 'call', name, input }, id);
      });
    },

    stream(name: string, input: unknown, opts?: CallOptions) {
      const id = nextId();
      const stream = new PushStream<unknown, unknown>(() => {
        // 消费方提前结束迭代
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        p.cleanup();
        post({ t: 'abort', id });
      });
      if (closed) {
        stream.fail(new ContractError('TRANSPORT', 'Transport closed'));
        return stream;
      }
      if (opts?.signal?.aborted) {
        stream.fail(abortedError());
        return stream;
      }
      pending.set(id, { kind: 'stream', stream, cleanup: () => {} });
      const cleanup = bindAbort(id, opts?.signal);
      const p = pending.get(id);
      if (p) p.cleanup = cleanup;
      post({ t: 'req', id, kind: 'stream', name, input }, id);
      return stream;
    },

    subscribe(event: string, fn: (data: unknown) => void): () => void {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
        post({ t: 'sub', event });
      }
      set.add(fn);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        set.delete(fn);
        if (set.size === 0 && listeners.get(event) === set) {
          listeners.delete(event);
          post({ t: 'unsub', event });
        }
      };
    },

    close(): void {
      if (closed) return;
      for (const event of listeners.keys()) post({ t: 'unsub', event });
      closed = true;
      listeners.clear();
      for (const id of [...pending.keys()]) {
        settleError(id, new ContractError('TRANSPORT', 'Transport closed'));
      }
      offPort();
    },
  };
}
