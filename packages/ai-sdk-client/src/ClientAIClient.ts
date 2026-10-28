/**
 * ClientAIClient —— 渲染进程侧的 AI 门面，签名与 [AIClient](file:///../../ai-sdk/src/AIClient.ts) 一致。
 *
 * 实现在应用契约上（docs/design/core-host-decoupling.md §4、§5、§12 P1）：
 * `createClient(appContract, transport)`，默认传输是 preload 暴露的 `window.nomiTransport`
 * （Electron IPC，`@nomi-ai/contract` 的 `createIpcClientTransport`）。
 *
 * - **门面**：每个 `client.<facade>.<method>(...)` 按 `AI_METHODS` 把位置参数打包成过程入参，
 *   调用 `ai.<facade>.<method>`；表里没有的方法名返回 `undefined`（调用即 `is not a function`）；
 * - **流式方法**：返回 `AsyncIterable`；消费方提前结束（break / return / dispose）会取消契约流，
 *   内核据此中止上游生成；chat 选项里的 `signal` 不跨进程，改作这条流的取消信号；
 * - **事件**：`on(evt, fn)` 与 AIClient 语义一致，按需订阅对应的契约事件（`AI_EVENTS`），
 *   最后一个监听移除时退订，所以每个窗口只收到自己关心的事件；
 * - **错误还原**：内核把 `AIClientError` 的 code / retryable / hint 编在 message 里，
 *   这里用 [`SDKError.fromIpc`](file:///./errors.ts) 复原；流式失败统一为 `IPC_STREAM_ABORTED`；
 * - **Avatar**：`isAvailable()` 是同步方法，返回本地缓存（默认 false，可由选项预置）。
 */

import {
  ContractError,
  createClient,
  createIpcClientTransport,
  PushStream,
  type Client,
  type ClientTransport,
  type ContractStream,
  type FrameClientTransport,
} from '@nomi-ai/contract';
import {
  AI_EVENTS,
  AI_METHODS,
  aiArgsToInput,
  appContract,
  NOMI_TRANSPORT_GLOBAL,
  type AiClientEventName,
  type AiMethodSpec,
  type AppContract,
} from '@nomi-ai/contract/app';

import { SDKError, SDKErrorCodes } from './errors';
import { getGlobalBridge, type IPCBridge, type IpcUnsubscribe } from './IPCBridge';

export interface ClientAIClientOptions {
  /** 自定义契约传输（测试 / 无界面宿主用 in-process 传输）；优先于 `bridge`。调用方负责关闭。 */
  transport?: ClientTransport;
  /** 自定义 IPC 桥（`invoke` / `on`）；未传则读 `window.nomiTransport`（可用 bridgeName 覆盖）。 */
  bridge?: IPCBridge;
  /** window 上的桥接名，默认 `nomiTransport`（preload 暴露的契约传输）。 */
  bridgeName?: string;
  /** 可选：预置 avatar isAvailable 的默认值，避免首次 UI 判断闪烁。 */
  avatarAvailable?: boolean;
}

type Listener = (payload: unknown) => void;
type Procedure = (input?: unknown, opts?: { signal?: AbortSignal }) => unknown;

const METHOD_INDEX: ReadonlyMap<string, AiMethodSpec> = new Map(
  AI_METHODS.map((s) => [`${s.facade}.${s.method}`, s]),
);

const DONE: IteratorResult<unknown> = { value: undefined, done: true };

/** 契约错误 → SDKError：INTERNAL 的 message 里带着内核 AIClientError 的 `[CODE|…]` 前缀 */
function toSDKError(err: unknown): SDKError {
  if (err instanceof SDKError) return err;
  if (err instanceof ContractError && err.code !== 'INTERNAL') {
    return new SDKError(SDKErrorCodes.IPC_ERROR, `${err.code}: ${err.message}`, { cause: err });
  }
  return SDKError.fromIpc(err);
}

/** 流式失败：能还原业务 code 的保留，其余统一为 IPC_STREAM_ABORTED（与原 chunk 协议一致） */
function toStreamError(err: unknown): SDKError {
  const sdk = toSDKError(err);
  if (sdk.code !== SDKErrorCodes.IPC_ERROR) return sdk;
  const message = err instanceof Error ? err.message : String(err);
  return new SDKError(SDKErrorCodes.IPC_STREAM_ABORTED, message, { cause: err });
}

/**
 * 读 window 上的桥：用到时才读（第一次调用 / 订阅），没就绪不抛在构造里。
 * 视图按 `window.aiIPC` 是否存在决定要不要建客户端，桥缺失时调用以 BRIDGE_MISSING 失败、订阅不生效。
 */
function lazyGlobalTransport(bridgeName: string): ClientTransport {
  let inner: FrameClientTransport | undefined;
  const get = (): FrameClientTransport => {
    inner ??= createIpcClientTransport(getGlobalBridge(bridgeName));
    return inner;
  };
  return {
    call(name, input, opts) {
      try {
        return get().call(name, input, opts);
      } catch (err) {
        return Promise.reject(err);
      }
    },
    stream(name, input, opts) {
      try {
        return get().stream(name, input, opts);
      } catch (err) {
        const failed = new PushStream<unknown, unknown>();
        failed.fail(err);
        return failed;
      }
    },
    subscribe(event, fn) {
      try {
        return get().subscribe(event, fn);
      } catch {
        return () => undefined;
      }
    },
    close() {
      inner?.close();
    },
  };
}

function cryptoRandomId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

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

  private readonly api: Client<AppContract>;
  /** 传输是本客户端自己建的（读 window 上的桥）：dispose 时一并关闭；外部传入的不关 */
  private readonly ownsTransport: boolean;
  private readonly listeners = new Map<string, Set<Listener>>();
  /** 已订阅的契约事件：AIClient 事件名 → 退订函数 */
  private readonly subscriptions = new Map<string, () => void>();
  /** 进行中的流：dispose 时统一取消 */
  private readonly activeStreams = new Set<() => void>();
  private disposed = false;
  private avatarAvailableCache: boolean;

  constructor(opts: ClientAIClientOptions = {}) {
    this.ownsTransport = !opts.transport;
    const transport =
      opts.transport ??
      (opts.bridge
        ? createIpcClientTransport(opts.bridge)
        : lazyGlobalTransport(opts.bridgeName ?? NOMI_TRANSPORT_GLOBAL));
    this.api = createClient(appContract, transport);
    this.avatarAvailableCache = opts.avatarAvailable ?? false;

    this.chat = this.makeFacade('chat');
    this.sessions = this.makeFacade('sessions');
    this.tools = this.makeFacade('tools');
    this.asr = this.makeFacade('asr');
    this.tts = this.makeFacade('tts');
    this.avatar = this.makeAvatarFacade();
    this.memory = {
      facts: this.makeFacade('memory.facts'),
      summaries: this.makeFacade('memory.summaries'),
      userProfile: this.makeUserProfileFacade(),
    };
  }

  /** 订阅业务事件；返回反订阅函数（与 AIClient.on 语义一致） */
  on(evt: string, fn: (payload: unknown) => void): IpcUnsubscribe {
    this.assertLive();
    let bucket = this.listeners.get(evt);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(evt, bucket);
    }
    bucket.add(fn);
    this.ensureSubscribed(evt);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const b = this.listeners.get(evt);
      if (!b) return;
      b.delete(fn);
      if (b.size > 0) return;
      this.listeners.delete(evt);
      this.subscriptions.get(evt)?.();
      this.subscriptions.delete(evt);
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    // 先取消仍在进行的流（内核据此中止上游生成）
    for (const release of [...this.activeStreams]) {
      try {
        release();
      } catch {
        /* ignore */
      }
    }
    this.activeStreams.clear();
    this.disposed = true;
    for (const off of this.subscriptions.values()) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.subscriptions.clear();
    this.listeners.clear();
    if (this.ownsTransport) this.api.$close();
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new SDKError(SDKErrorCodes.DISPOSED, 'ClientAIClient 已 dispose');
    }
  }

  private ensureSubscribed(evt: string): void {
    if (this.subscriptions.has(evt)) return;
    const event = (AI_EVENTS as Record<string, (typeof AI_EVENTS)[AiClientEventName]>)[evt];
    if (!event) return; // 不是 AIClient 的业务事件：永远不会触发，与原实现一致
    this.subscriptions.set(
      evt,
      this.api.on(event, (data) => this.dispatch(evt, data)),
    );
  }

  private dispatch(evt: string, data: unknown): void {
    const bucket = this.listeners.get(evt);
    if (!bucket) return;
    for (const fn of [...bucket]) {
      try {
        fn(data);
      } catch (err) {
        // 单个监听器抛错不影响其他人
        console.error(`[ai-sdk-client] listener for '${evt}' threw`, err);
      }
    }
  }

  private procedure(spec: AiMethodSpec): Procedure {
    let node: unknown = this.api;
    for (const seg of spec.procedure.split('.')) {
      node = (node as Record<string, unknown> | undefined)?.[seg];
    }
    if (typeof node !== 'function') {
      throw new Error(`[ai-sdk-client] procedure '${spec.procedure}' missing in appContract`);
    }
    return node as Procedure;
  }

  /**
   * 构造门面。任何不在 `AI_METHODS` 里的方法名都返回 `undefined`，
   * 避免误调用被静默忽略——UI 会立刻收到 `is not a function` 错误。
   */
  private makeFacade(facade: string): Record<string, unknown> {
    const target: Record<string, unknown> = {};
    const cache = new Map<string, unknown>();
    return new Proxy(target, {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        const spec = METHOD_INDEX.get(`${facade}.${prop}`);
        if (!spec) return undefined;
        let fn = cache.get(prop);
        if (!fn) {
          fn = this.makeMethod(spec);
          cache.set(prop, fn);
        }
        return fn;
      },
      has: (_t, prop) => typeof prop === 'string' && METHOD_INDEX.has(`${facade}.${prop}`),
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
    const base = this.makeFacade('memory.userProfile');
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

  private makeMethod(spec: AiMethodSpec) {
    if (appContract.procedures[spec.procedure].kind === 'stream') {
      return (...args: unknown[]) => this.makeStream(spec, args);
    }
    return async (...args: unknown[]) => {
      this.assertLive();
      try {
        return await this.procedure(spec)(aiArgsToInput(spec, args));
      } catch (err) {
        throw toSDKError(err);
      }
    };
  }

  /**
   * 流：契约流的薄包装。
   * - chat 流的首参是选项对象：没有 reqId 时生成一个并写回（调用方据此调用 `chat.abort(reqId)`）；
   *   `signal` 不跨进程，作为这条流的取消信号；
   * - 消费方提前结束（break / return / throw）或 dispose：取消契约流，挂起的 next() 以 done 结束；
   * - 内核报错：已收到的 chunk 先排空，再抛 SDKError。
   */
  private makeStream(spec: AiMethodSpec, args: unknown[]): AsyncIterable<unknown> {
    const ctrl = new AbortController();
    let released = false;
    let source: AsyncIterator<unknown> | undefined;
    let startError: unknown;
    let userSignal: AbortSignal | undefined;

    const finish = (): void => {
      if (released) return;
      released = true;
      this.activeStreams.delete(release);
      userSignal?.removeEventListener('abort', release);
    };
    // 提前结束：取消契约流（abort 帧 → 内核的 ctx.signal → 中止上游）
    const release = (): void => {
      if (released) return;
      finish();
      ctrl.abort();
    };

    try {
      this.assertLive();
      let input = aiArgsToInput(spec, args);
      if (spec.facade === 'chat' && input && typeof input === 'object') {
        const options = input as { reqId?: string; signal?: AbortSignal };
        options.reqId ??= cryptoRandomId();
        const { signal, ...rest } = options;
        userSignal = signal;
        input = rest;
      }
      if (userSignal?.aborted) {
        released = true;
      } else {
        const stream = this.procedure(spec)(input, {
          signal: ctrl.signal,
        }) as ContractStream<unknown, unknown>;
        source = stream[Symbol.asyncIterator]();
        this.activeStreams.add(release);
        userSignal?.addEventListener('abort', release, { once: true });
      }
    } catch (err) {
      startError = err;
      released = true;
    }

    const iterator: AsyncIterator<unknown> = {
      next: async (): Promise<IteratorResult<unknown>> => {
        if (startError !== undefined) {
          const err = startError;
          startError = undefined;
          throw toSDKError(err);
        }
        if (released || !source) return DONE;
        try {
          const r = await source.next();
          if (!r.done) return { value: r.value, done: false };
          finish();
          return DONE;
        } catch (err) {
          if (released) return DONE;
          finish();
          throw toStreamError(err);
        }
      },
      return: async () => {
        release();
        return DONE;
      },
      throw: async (err) => {
        release();
        throw err;
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }
}
