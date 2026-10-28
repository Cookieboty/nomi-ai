/**
 * 服务端会话：把一条连接（一个窗口 / 一个 WebSocket / 一个 in-process 客户端）上的帧
 * 交给 router 处理。所有传输实现共用它，线协议只在这里解释一次。
 *
 * - 每个请求有自己的 AbortController：abort 帧、会话关闭都会触发 `ctx.signal`；
 * - 流：逐个 `next()`，每个值发一个 chunk 帧；结束发 end 帧（带最终结果），失败发 err 帧；
 * - 事件：按会话订阅（取代 EventBroadcaster 的按窗口过滤，§5.3）；
 * - `send` 返回 false 视为连接已断（窗口销毁）：关闭会话、取消全部进行中的调用；
 *   `send` 抛错视为这一帧发不出去（如不可序列化），对带 id 的帧改发 err 帧；
 * - 流以任何方式提前结束（chunk 校验失败、chunk 发不出去、取消、连接断开）都会调用
 *   处理函数迭代器的 `return()`，让 generator 的 finally 执行；
 * - `strictSerialize`：发出前对每一帧做 `findUnserializable` 检查（§4.2），
 *   在 IPC 的 structuredClone 能放过的 Date / Map / Set 等也会被拦下，提前暴露以后 WebSocket 传不了的值。
 */

import { canSubscribe } from './contract';
import { abortedError, type ContractError, isContractError, toErrorPayload } from './errors';
import {
  clientFrameSchema,
  findUnserializable,
  type ClientFrame,
  type ServerFrame,
} from './protocol';
import type { CallerContext, Router } from './router';
import type { ContractLogger } from './transport';

export interface ServerSessionOptions {
  caller: CallerContext;
  /** 发一帧给客户端；返回 false 表示连接已断 */
  send(frame: ServerFrame): boolean | void;
  /** 会话关闭（主动 close 或发现连接已断）时回调 */
  onClose?(): void;
  logger?: ContractLogger;
  /** 单会话同时进行的请求上限（默认 256），超出直接以 BAD_REQUEST 拒绝 */
  maxInflight?: number;
  /**
   * 发出前检查每一帧只含 JSON 值与 Uint8Array（`findUnserializable`）。不合规的结果 / chunk
   * 以 BAD_OUTPUT 失败，不合规的事件丢弃并 warn。默认：`NODE_ENV !== 'production'` 时开启
   * （开发与测试），生产环境关闭以省掉逐帧遍历。
   */
  strictSerialize?: boolean;
}

/** strictSerialize 的默认值：开发 / 测试开启，生产关闭 */
export function defaultStrictSerialize(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.NODE_ENV !== 'production';
}

/** 发帧结果：送出 / 改发了 err 帧（这一帧不可序列化）/ 连接已断 */
type SendStatus = 'sent' | 'replaced' | 'closed';

export interface ServerSession {
  readonly caller: CallerContext;
  readonly closed: boolean;
  /** 收到客户端的一帧（未校验的原始值） */
  receive(raw: unknown): void;
  /**
   * 关闭会话：取消全部进行中的调用、移除订阅。传入 `reason` 时（连接仍在、只是会话被丢弃，
   * 如超出会话上限被挤掉）先给每个进行中的调用发一个 err 帧，客户端不会一直等下去。
   */
  close(reason?: ContractError): void;
}

export function createServerSession(router: Router, opts: ServerSessionOptions): ServerSession {
  const inflight = new Map<string, AbortController>();
  const subscriptions = new Map<string, () => void>();
  const maxInflight = opts.maxInflight ?? 256;
  const strict = opts.strictSerialize ?? defaultStrictSerialize();
  let closed = false;

  const close = (reason?: ContractError): void => {
    if (closed) return;
    if (reason) {
      const error = reason.toJSON();
      for (const id of [...inflight.keys()]) {
        try {
          opts.send({ t: 'err', id, error });
        } catch {
          // 连接已不可用：下面照常关闭
        }
      }
    }
    closed = true;
    for (const ctrl of inflight.values()) ctrl.abort(abortedError('Connection closed'));
    inflight.clear();
    for (const off of subscriptions.values()) off();
    subscriptions.clear();
    opts.onClose?.();
  };

  /** 发帧；返回发送结果 */
  const sendFrame = (frame: ServerFrame): SendStatus => {
    if (closed) return 'closed';
    try {
      if (strict) {
        const bad = findUnserializable(frame);
        if (bad) throw new TypeError(`value is not wire-safe (${bad})`);
      }
      if (opts.send(frame) === false) {
        close();
        return 'closed';
      }
      return 'sent';
    } catch (err) {
      // err 帧的 data 不可序列化：去掉 data 再发一次，免得客户端一直等
      if (frame.t === 'err' && frame.error.data !== undefined) {
        const { code, message } = frame.error;
        return sendFrame({ t: 'err', id: frame.id, error: { code, message } });
      }
      if (frame.t === 'err' || frame.t === 'event') {
        opts.logger?.warn('[contract] failed to send frame', { frame: frame.t, err });
        return closed ? 'closed' : 'replaced';
      }
      // 结果 / chunk 发不出去（多半是不可序列化）：告诉客户端这次调用失败
      const message = err instanceof Error ? err.message : String(err);
      const status = sendFrame({
        t: 'err',
        id: frame.id,
        error: { code: 'BAD_OUTPUT', message: `Unserializable ${frame.t}: ${message}` },
      });
      return status === 'closed' ? 'closed' : 'replaced';
    }
  };

  /** 发帧；返回是否仍连通 */
  const send = (frame: ServerFrame): boolean => sendFrame(frame) !== 'closed';

  const sendError = (id: string, err: unknown): void => {
    if (!isContractError(err)) {
      opts.logger?.warn('[contract] handler threw', err);
    }
    send({ t: 'err', id, error: toErrorPayload(err) });
  };

  const handleCall = (id: string, name: string, input: unknown, ctrl: AbortController): void => {
    router
      .call(name, input, { caller: opts.caller, signal: ctrl.signal })
      .then(
        (output) => {
          if (!ctrl.signal.aborted) send({ t: 'res', id, output });
        },
        (err) => {
          if (!ctrl.signal.aborted) sendError(id, err);
        },
      )
      .finally(() => {
        if (inflight.get(id) === ctrl) inflight.delete(id);
      });
  };

  const handleStream = (id: string, name: string, input: unknown, ctrl: AbortController): void => {
    void (async () => {
      let it: AsyncIterator<unknown, unknown> | undefined;
      /** 正常读到 done 时为 true；其余任何退出路径都要 return() 迭代器 */
      let finished = false;
      try {
        it = await router.stream(name, input, { caller: opts.caller, signal: ctrl.signal });
        for (;;) {
          if (ctrl.signal.aborted) return;
          const r = await it.next();
          if (ctrl.signal.aborted) return;
          if (r.done) {
            finished = true;
            send({ t: 'end', id, output: r.value });
            return;
          }
          // chunk 发不出去：连接已断，或已改发 err 帧（客户端那边这次调用已经失败）
          if (sendFrame({ t: 'chunk', id, data: r.value }) !== 'sent') return;
        }
      } catch (err) {
        if (!ctrl.signal.aborted) sendError(id, err);
      } finally {
        if (inflight.get(id) === ctrl) inflight.delete(id);
        if (it && !finished) {
          try {
            await it.return?.();
          } catch (err) {
            opts.logger?.warn('[contract] stream cleanup threw', err);
          }
        }
      }
    })();
  };

  const receive = (raw: unknown): void => {
    if (closed) return;
    const parsed = clientFrameSchema.safeParse(raw);
    if (!parsed.success) {
      const id = (raw as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
        send({ t: 'err', id, error: { code: 'BAD_REQUEST', message: 'Malformed frame' } });
      } else {
        opts.logger?.warn('[contract] dropped malformed frame');
      }
      return;
    }
    const frame: ClientFrame = parsed.data;
    switch (frame.t) {
      case 'req': {
        if (inflight.has(frame.id)) {
          send({
            t: 'err',
            id: frame.id,
            error: { code: 'BAD_REQUEST', message: `Duplicate request id '${frame.id}'` },
          });
          return;
        }
        if (inflight.size >= maxInflight) {
          send({
            t: 'err',
            id: frame.id,
            error: { code: 'BAD_REQUEST', message: 'Too many concurrent requests' },
          });
          return;
        }
        const ctrl = new AbortController();
        inflight.set(frame.id, ctrl);
        if (frame.kind === 'stream') handleStream(frame.id, frame.name, frame.input, ctrl);
        else handleCall(frame.id, frame.name, frame.input, ctrl);
        return;
      }
      case 'abort': {
        const ctrl = inflight.get(frame.id);
        if (ctrl) {
          inflight.delete(frame.id);
          ctrl.abort(abortedError());
        }
        return;
      }
      case 'sub': {
        if (subscriptions.has(frame.event) || !router.events.has(frame.event)) return;
        // 事件的界面白名单（契约 eventSurfaces，§8）：别的界面的订阅与未知事件一样忽略
        if (!canSubscribe(router.contract, frame.event, opts.caller.surface)) return;
        const event = frame.event;
        const off = router.events.subscribe(event, (data) => {
          send({ t: 'event', event, data });
        });
        subscriptions.set(event, off);
        return;
      }
      case 'unsub': {
        subscriptions.get(frame.event)?.();
        subscriptions.delete(frame.event);
        return;
      }
    }
  };

  return {
    caller: opts.caller,
    get closed() {
      return closed;
    },
    receive,
    close,
  };
}
