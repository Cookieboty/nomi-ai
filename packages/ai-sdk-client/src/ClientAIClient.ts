/**
 * ClientAIClient —— 渲染进程侧的 IPC Proxy，签名与 [P5 AIClient](file:///../../ai-sdk/src/AIClient.ts) 完全一致。
 *
 * 设计要点（对齐 P7 计划 §P7-2）：
 * - **反射构造**：每个 Facade 用 `Proxy` 拦截 `get`，将 `client.<facade>.<method>(...)`
 *   路由到 `bridge.invoke('ai:<facade>:<method>', ...)`；
 * - **流式方法**：通过 `IPC_METHOD_INDEX` 命中 `kind === 'stream'`，返回一个
 *   `AsyncIterable`，内部订阅 `ai:<facade>:<method>:chunk` 事件并按 `reqId` 关联；
 * - **事件订阅**：所有 插件事件走单一 `ai:event` 通道，由 `ClientAIClient` 本地做
 *   pub/sub 二次分发；`on(evt, fn)` 语义与 P5 `AIClient.on` 一致；
 * - **错误还原**：`bridge.invoke` 抛错时用 [`SDKError.fromIpc`](file:///./errors.ts) 复原 code/message；
 * - **Avatar**：因为 `isAvailable()` 是同步方法，本客户端把 IPC 结果**懒缓存**在本地一次，
 *   之后同步返回；首次未调用时保守返回 `false`，与 P5 语义一致；
 * - **memory 扁平化**：P6 IPCTransportServer 把 `memory.userProfile/facts/summaries`
 *   拉平到通道前缀（例如 `ai:userProfile:set`）；本客户端相应地把 `memory.userProfile`
 *   路由到 `userProfile` 通道。
 */

import { AI_EVENT_CHANNEL, IPC_METHOD_INDEX, channelName, chunkChannelName } from './channels';
import type { IpcMethodSpec } from './channels';
import { SDKError, SDKErrorCodes } from './errors';
import { getGlobalBridge, type IPCBridge, type IpcUnsubscribe } from './IPCBridge';

export interface ClientAIClientOptions {
  /** 自定义 IPC bridge；未传则读 `window.aiIPC`（可通过 bridgeName 覆盖）。 */
  bridge?: IPCBridge;
  /** window 上的桥接名，默认 `aiIPC`，与 mkAiPreload 保持一致。 */
  bridgeName?: string;
  /** 可选：预置 avatar isAvailable 的默认值，避免首次 UI 判断闪烁。 */
  avatarAvailable?: boolean;
}

/**
 * 通用 chunk 协议——与 [`IPCTransportServer.handleStream`](file:///../../ai-runtime/src/IPCTransportServer.ts) 对齐：
 *   { reqId, done: false, value }   // 每次 next 的数据
 *   { reqId, done: true, error? }   // 结束或异常
 */
interface StreamChunkEnvelope<V = unknown> {
  reqId: string;
  done: boolean;
  value?: V;
  error?: string;
}

interface EventEnvelope {
  evt: string;
  data: unknown;
}

type Listener = (payload: unknown) => void;

export class ClientAIClient {
  readonly chat: Record<string, unknown>;
  readonly sessions: Record<string, unknown>;
  readonly tools: Record<string, unknown>;
  readonly memory: {
    facts: Record<string, unknown>;
    summaries: Record<string, unknown>;
    userProfile: Record<string, unknown>;
  };
  readonly asr: Record<string, unknown>;
  readonly tts: Record<string, unknown>;
  readonly avatar: Record<string, unknown>;

  private readonly bridge: IPCBridge;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly disposers: IpcUnsubscribe[] = [];
  /** 进行中的流：dispose 时统一释放（退订 + 唤醒挂起的 next + chat 流通知中止） */
  private readonly activeStreams = new Set<() => void>();
  private disposed = false;
  private avatarAvailableCache: boolean;

  constructor(opts: ClientAIClientOptions = {}) {
    this.bridge = opts.bridge ?? getGlobalBridge(opts.bridgeName ?? 'aiIPC');
    this.avatarAvailableCache = opts.avatarAvailable ?? false;

    this.chat = this.makeFacade('chat');
    this.sessions = this.makeFacade('sessions');
    this.tools = this.makeFacade('tools');
    this.asr = this.makeFacade('asr');
    this.tts = this.makeFacade('tts');
    this.avatar = this.makeAvatarFacade();
    this.memory = {
      facts: this.makeFacade('facts'),
      summaries: this.makeFacade('summaries'),
      userProfile: this.makeUserProfileFacade(),
    };

    this.disposers.push(
      this.bridge.on<EventEnvelope>(AI_EVENT_CHANNEL, (payload) => {
        if (!payload || typeof payload !== 'object') return;
        this.dispatch(payload.evt, payload.data);
      }),
    );
  }

  /** 订阅业务事件；返回反订阅函数（与 P5 AIClient.on 语义一致） */
  on(evt: string, fn: (payload: unknown) => void): IpcUnsubscribe {
    this.assertLive();
    let bucket = this.listeners.get(evt);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(evt, bucket);
    }
    bucket.add(fn);
    return () => bucket?.delete(fn);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    // 先释放仍在进行的流（此时还没标记 disposed，chat 流的中止通知可以发出）
    for (const release of [...this.activeStreams]) {
      try {
        release();
      } catch {
        /* ignore */
      }
    }
    this.activeStreams.clear();
    this.disposed = true;
    for (const off of this.disposers.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.listeners.clear();
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new SDKError(SDKErrorCodes.DISPOSED, 'ClientAIClient 已 dispose');
    }
  }

  private dispatch(evt: string, data: unknown): void {
    const bucket = this.listeners.get(evt);
    if (!bucket) return;
    for (const fn of bucket) {
      try {
        fn(data);
      } catch (err) {
        // 单个监听器抛错不影响其他人
        console.error(`[ai-sdk-client] listener for '${evt}' threw`, err);
      }
    }
  }

  /**
   * 构造 Proxy Facade。任何未在通道白名单里的方法名都会返回 `undefined`，
   * 避免误注册的调用被静默忽略——UI 会立刻收到 `is not a function` 错误。
   */
  private makeFacade(facade: string): Record<string, unknown> {
    const target: Record<string, unknown> = {};
    return new Proxy(target, {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        const spec = IPC_METHOD_INDEX.get(`${facade}.${prop}`);
        if (!spec) return undefined;
        return this.makeMethod(spec);
      },
      has: (_t, prop) => typeof prop === 'string' && IPC_METHOD_INDEX.has(`${facade}.${prop}`),
    });
  }

  private makeAvatarFacade(): Record<string, unknown> {
    const base = this.makeFacade('avatar');
    return new Proxy(base, {
      get: (_t, prop) => {
        if (prop === 'isAvailable') return () => this.avatarAvailableCache;
        if (prop === 'on') {
          return (evt: string, fn: (p: unknown) => void) => {
            const local = evt.startsWith('avatar:') ? evt : `avatar:${evt}`;
            return this.on(local, fn);
          };
        }
        return (base as Record<string, unknown>)[prop as string];
      },
    });
  }

  private makeUserProfileFacade(): Record<string, unknown> {
    const base = this.makeFacade('userProfile');
    return new Proxy(base, {
      get: (_t, prop) => {
        if (prop === 'subscribe') {
          return (fn: (p: unknown) => void) => {
            return this.on('userProfile:changed', (payload) => {
              const p = payload as { profile?: unknown } | undefined;
              fn(p?.profile ?? payload);
            });
          };
        }
        return (base as Record<string, unknown>)[prop as string];
      },
    });
  }

  /**
   * 构造一个方法：
   * - 非 stream：直接 `invoke` 并 SDKError.fromIpc 包一层；
   * - stream：返回一个 `AsyncIterable`，内部维护一个 buffer + Promise 的轮询队列，
   *   与主进程 `handleStream` 的 chunk 协议对齐。
   */
  private makeMethod(spec: IpcMethodSpec) {
    const ch = channelName(spec);
    if (spec.kind === 'stream') {
      return (...args: unknown[]) => this.makeStream(spec, ch, args);
    }
    return async (...args: unknown[]) => {
      this.assertLive();
      try {
        return await this.bridge.invoke(ch, ...args);
      } catch (err) {
        throw SDKError.fromIpc(err);
      }
    };
  }

  private makeStream(spec: IpcMethodSpec, ch: string, args: unknown[]): AsyncIterable<unknown> {
    const chunkCh = chunkChannelName(spec);
    const buffer: unknown[] = [];
    let ended = false;
    let error: SDKError | undefined;
    let resolver: (() => void) | undefined;
    let unsub: IpcUnsubscribe | undefined;
    let reqId: string | undefined;
    // 服务端已自然收尾（done / 出错）：之后的 return() 不必再通知中止
    let finishedByServer = false;
    // chat 流被消费方提前放弃（break / return / throw）时，要通知主进程中止上游请求
    const abortable = spec.facade === 'chat';

    // 幂等退订 chunk 监听，并把这条流从活动集合里摘掉
    const detach = () => {
      const u = unsub;
      unsub = undefined;
      u?.();
      this.activeStreams.delete(release);
    };

    const scheduleWake = () => {
      const r = resolver;
      resolver = undefined;
      r?.();
    };

    const wait = () =>
      new Promise<void>((resolve) => {
        if (buffer.length > 0 || ended) return resolve();
        resolver = resolve;
      });

    // 消费方提前结束：退订 chunk、唤醒挂起的 next()，并 fire-and-forget 通知主进程中止
    const release = () => {
      const alreadyEnded = ended;
      ended = true;
      detach();
      scheduleWake();
      if (abortable && !alreadyEnded && !finishedByServer && reqId) {
        const abortSpec = IPC_METHOD_INDEX.get('chat.abort');
        if (abortSpec && !this.disposed) {
          void Promise.resolve(this.bridge.invoke(channelName(abortSpec), reqId)).catch(
            () => undefined,
          );
        }
      }
    };

    const kickOff = async () => {
      this.assertLive();
      // 生成 reqId，随后订阅 chunk 通道。
      // chat 流的首参本来就是 options 对象：reqId 写进它（若已带则复用）。
      // 其它流（tts.stream(text, opts) 等）的位置参数是业务参数，不能被改写：
      // reqId 单独放在最前面的 envelope `{ reqId }` 里，服务端取出后再用原参数调用。
      if (spec.facade === 'chat') {
        const first = args[0] as { reqId?: string } | undefined;
        reqId = first?.reqId ?? cryptoRandomId();
        if (first && typeof first === 'object') {
          (first as { reqId?: string }).reqId = reqId;
        } else {
          args = [{ reqId }, ...args];
        }
      } else {
        reqId = cryptoRandomId();
        args = [{ reqId }, ...args];
      }
      const id = reqId;
      unsub = this.bridge.on<StreamChunkEnvelope>(chunkCh, (env) => {
        if (!env || env.reqId !== id) return;
        if (env.done) {
          finishedByServer = true;
          if (env.error) error = new SDKError(SDKErrorCodes.IPC_STREAM_ABORTED, env.error);
          ended = true;
          // 自然结束就退订：已缓冲的 chunk 仍可被 next() 排空，不依赖消费方调用 return()
          detach();
          scheduleWake();
          return;
        }
        buffer.push(env.value);
        scheduleWake();
      });
      // 订阅回调可能在 on() 返回前同步触发 done：此时补一次退订
      if (ended) detach();
      try {
        await this.bridge.invoke(ch, ...args);
      } catch (err) {
        error = SDKError.fromIpc(err);
        ended = true;
        detach();
        scheduleWake();
      }
    };

    // 立即启动 subscribe + invoke；调用方后续 iterate 时按 buffer 消费。
    this.activeStreams.add(release);
    const started = kickOff();

    const iterator: AsyncIterator<unknown> = {
      next: async (): Promise<IteratorResult<unknown>> => {
        await started;
        while (buffer.length === 0 && !ended) await wait();
        if (buffer.length > 0) {
          const value = buffer.shift();
          return { value, done: false };
        }
        if (error) throw error;
        return { value: undefined, done: true };
      },
      return: async () => {
        release();
        return { value: undefined, done: true };
      },
      throw: async (err) => {
        release();
        throw err;
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }
}

function cryptoRandomId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
