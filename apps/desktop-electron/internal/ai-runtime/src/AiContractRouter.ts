/**
 * AI 门面的契约实现（docs/design/core-host-decoupling.md §4.1、§5.3、§12 P1）。
 *
 * `implement(appContract, …)`：每个 `ai.*` 过程委派给 `AIClient` 的对应门面方法，
 * 取代原来按 `IPC_METHODS` 反射挂 `ai:<facade>:<method>` 通道的 IPCTransportServer。
 * `AIClient.on(evt)` 的 12 个业务事件转成契约事件 `ctx.events.publish(...)`，由传输层按
 * 每个连接的订阅推送（取代 EventBroadcaster 的「按窗口订阅子集」）。
 *
 * 本文件不认识窗口，也不 import electron：Electron 的 IPC 传输由宿主挂上（host-electron/src/host）。
 *
 * 保留的行为：
 * - 流式文本片段按帧（16 ms）合批，其它 chunk 顺序不变；
 * - chat 请求先过宿主的外发检查（`prepareChat`），检查期间被停止的轮次不再创建上游请求；
 * - 调用方取消（abort 帧、窗口关闭 / 导航）时通知 chat 门面中止上游生成。
 */

import type { AIClient, AIClientEvent } from '@nomi-ai/ai-sdk';
import type { ChatChunk } from '@nomi-ai/bundle-ig-base';
import {
  ContractError,
  implement,
  type EventPublisher,
  type HandlerContext,
  type Handlers,
  type Middleware,
  type Router,
} from '@nomi-ai/contract';
import {
  AI_EVENTS,
  appContract,
  type AppContract,
  type AiClientEventName,
  type AiProcedureName,
} from '@nomi-ai/contract/app';

import type { RuntimeLogger } from './logger';
import { ConsoleRuntimeLogger } from './logger';
import type { ObservabilityBridge, ObservabilityBridgeOptions } from './ObservabilityBridge';
import { createObservabilityBridge } from './ObservabilityBridge';

/** 流式文本片段合批的间隔（约一帧） */
export const STREAM_BATCH_MS = 16;

export type PrepareChat = (
  options: Record<string, unknown>,
  method: string,
  signal?: AbortSignal,
) => Promise<void>;

export interface AiRouterOptions {
  client: AIClient;
  logger?: RuntimeLogger;
  /**
   * chat 门面请求真正发出前的主进程检查（如本地文件内容的外发授权）：可就地改写 options.messages；
   * 抛错则这次请求失败。流式请求带 signal：用户在检查等待中停止该轮时触发，用来撤掉还没答复的确认；
   * 无论检查结果如何，已停止的轮次都不会再创建上游请求。
   */
  prepareChat?: PrepareChat;
  /**
   * 埋点桥（P9-2/P9-3）：`true` 用默认配置，传对象自定义；默认关闭（防止意外出网 / 隐私泄漏）。
   */
  observability?: boolean | ObservabilityBridge | ObservabilityBridgeOptions;
  /** 是否把 AIClient 事件发布为契约事件（默认 true） */
  publishEvents?: boolean;
  /** 文本合批间隔，测试用（默认 STREAM_BATCH_MS） */
  streamBatchMs?: number;
}

export interface AiRouterHandle {
  router: Router<AppContract>;
  /** 退订 AIClient 事件、清理埋点；不停止传输（传输由宿主停止） */
  dispose(): void;
}

/** AI 门面（`ai.*`）的处理函数 */
export type AiHandlers = Pick<Handlers<AppContract>, AiProcedureName>;
/** 契约里 AI 门面之外的处理函数（P1b 各域，由宿主组装） */
export type NonAiHandlers = Omit<Handlers<AppContract>, AiProcedureName>;

export interface AiHandlersHandle {
  handlers: AiHandlers;
  /**
   * 把 AIClient 的业务事件发布到契约事件（`publishEvents !== false` 时）。宿主建好 router 后调用一次；
   * 返回退订函数（dispose 也会退订）。
   */
  bindEvents(publisher: EventPublisher<AppContract>): () => void;
  /** 退订事件、中止进行中的 chat 流、清理埋点 */
  dispose(): void;
}

export interface AiRouterExtraOptions {
  /** AI 门面之外的处理函数；缺的过程调用时以 NOT_FOUND 失败 */
  handlers?: Partial<NonAiHandlers>;
  middleware?: readonly Middleware[];
}

type Ctx = HandlerContext<AppContract>;
type ChatMethod = 'stream' | 'regenerate' | 'agentStream';

/** 只含 { type: 'delta' | 'reasoning', content: string } 的 chunk 可以与相邻的同类片段拼接 */
function mergeableText(value: unknown): { type: 'delta' | 'reasoning'; content: string } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if ((v.type !== 'delta' && v.type !== 'reasoning') || typeof v.content !== 'string') return null;
  if (Object.keys(v).length !== 2) return null;
  return { type: v.type, content: v.content };
}

const FLUSH = Symbol('flush');

/**
 * 逐 token 的文本片段按帧合批：上游每个 text-delta（常常只有一个 token）原来都单独发一帧，
 * 每秒几十上百次结构化克隆 + 进程调度。相邻的同类文本片段先拼起来，`ms` 内发一次；
 * 其它 chunk 先把攒着的文本发出去再原样发送，顺序不变。
 */
export async function* batchTextChunks<T, R>(
  source: AsyncIterable<T>,
  ms: number,
): AsyncGenerator<T, R | undefined, unknown> {
  const it = source[Symbol.asyncIterator]();
  let held: { type: 'delta' | 'reasoning'; content: string } | null = null;
  let deadline = 0;
  let pending: Promise<IteratorResult<T, R>> | null = null;
  let finished = false;
  try {
    for (;;) {
      pending ??= it.next();
      let r: IteratorResult<T, R> | typeof FLUSH;
      if (held) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const flush = new Promise<typeof FLUSH>((resolve) => {
          timer = setTimeout(() => resolve(FLUSH), Math.max(0, deadline - Date.now()));
        });
        try {
          r = await Promise.race([pending, flush]);
        } finally {
          clearTimeout(timer);
        }
      } else {
        r = await pending;
      }
      if (r === FLUSH) {
        const out = held as T | null;
        held = null;
        if (out) yield out;
        continue;
      }
      pending = null;
      if (r.done) {
        finished = true;
        if (held) {
          const out = held as T;
          held = null;
          yield out;
        }
        return r.value;
      }
      const text = mergeableText(r.value);
      if (text) {
        if (held && held.type === text.type) {
          held.content += text.content;
          continue;
        }
        if (held) {
          const out = held as T;
          held = { ...text };
          deadline = Date.now() + ms;
          yield out;
          continue;
        }
        held = { ...text };
        deadline = Date.now() + ms;
        continue;
      }
      if (held) {
        const out = held as T;
        held = null;
        yield out;
      }
      yield r.value;
    }
  } finally {
    if (!finished) {
      // 提前结束（取消 / 下游出错）：释放上游迭代器。还有未完成的 next() 时不等它，
      // 上游由 chat.abort 停止，return() 排在那次 next() 之后执行
      const done = it.return?.();
      if (pending) void Promise.resolve(done).catch(() => undefined);
      else await done;
    }
  }
}

function randomId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 去掉不可序列化 / 视图不用的 `raw` 字段 */
function withoutRaw<T extends { raw?: unknown }>(value: T): Omit<T, 'raw'> {
  if (!value || typeof value !== 'object' || !('raw' in value)) return value;
  const { raw: _raw, ...rest } = value;
  return rest;
}

export function createAiHandlers(opts: AiRouterOptions): AiHandlersHandle {
  const { client } = opts;
  const logger = opts.logger ?? ConsoleRuntimeLogger;
  const batchMs = opts.streamBatchMs ?? STREAM_BATCH_MS;
  const bridge = resolveObservabilityBridge(opts.observability);
  /** 进行中的 chat 流：reqId → 本轮的取消控制器（覆盖外发检查到收尾的整个生命周期） */
  const streamAborts = new Map<string, AbortController>();

  const prepare = async (
    options: Record<string, unknown>,
    method: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (opts.prepareChat) await opts.prepareChat(options, method, signal);
  };

  const abortUpstream = (reqId: string): void => {
    try {
      client.chat.abort(reqId);
    } catch (err) {
      logger.warn('abort upstream failed', err);
    }
  };

  async function* chatStream(
    method: ChatMethod,
    input: Record<string, unknown> & { reqId?: string },
    ctx: Ctx,
  ): AsyncGenerator<ChatChunk, void, unknown> {
    const reqId = input.reqId ?? randomId();
    input.reqId = reqId;
    // 从收到起就登记取消所有权：外发检查等待确认时用户点停止，chat.abort 也能命中这一轮
    const aborter = new AbortController();
    streamAborts.set(reqId, aborter);
    // 调用方取消（abort 帧、窗口关闭 / 导航）：撤掉检查，并让上游停止生成，别白白烧 token
    const onCancel = () => {
      aborter.abort();
      abortUpstream(reqId);
    };
    ctx.signal.addEventListener('abort', onCancel, { once: true });
    try {
      try {
        await prepare(input, method, aborter.signal);
      } catch (err) {
        // 停止导致的失败（如撤掉确认后的「已取消」）：静默结束，不当作错误
        if (aborter.signal.aborted) return;
        throw err;
      }
      // 检查期间已停止：不管确认最后是允许还是拒绝，都不再创建上游请求
      if (aborter.signal.aborted) return;
      const options = input as unknown as Parameters<AIClient['chat']['stream']>[0];
      const source = client.chat[method](options);
      try {
        yield* batchTextChunks<ChatChunk, void>(source, batchMs);
      } catch (err) {
        if (aborter.signal.aborted) return;
        logger.warn(`stream chat.${method} threw`, err);
        throw err;
      }
    } finally {
      ctx.signal.removeEventListener('abort', onCancel);
      // 只清理本轮登记的：同一 reqId 的新一轮已经登记时不能误删
      if (streamAborts.get(reqId) === aborter) streamAborts.delete(reqId);
    }
  }

  const handlers: AiHandlers = {
    // chat
    'ai.chat.sendMessage': async (input) => {
      await prepare(input, 'sendMessage');
      return withoutRaw(await client.chat.sendMessage(input));
    },
    'ai.chat.stream': (input, ctx) => chatStream('stream', input, ctx),
    'ai.chat.regenerate': (input, ctx) => chatStream('regenerate', input, ctx),
    'ai.chat.agentStream': (input, ctx) => chatStream('agentStream', input, ctx),
    'ai.chat.abort': ({ reqId }) => {
      // 还在外发检查里的流没有上游请求可停：在这里标记取消，检查结束后不再创建（#160）
      streamAborts.get(reqId)?.abort();
      client.chat.abort(reqId);
    },

    // sessions
    'ai.sessions.list': () => client.sessions.list(),
    'ai.sessions.get': ({ id }) => client.sessions.get(id),
    'ai.sessions.create': (input) => client.sessions.create(input),
    'ai.sessions.fork': ({ id, overrides }) => client.sessions.fork(id, overrides),
    'ai.sessions.rename': ({ id, title }) => client.sessions.rename(id, title),
    'ai.sessions.delete': ({ id }) => client.sessions.delete(id),

    // tools
    'ai.tools.list': () => client.tools.list(),
    'ai.tools.setEnabled': ({ name, enabled }) => client.tools.setEnabled(name, enabled),
    'ai.tools.confirm': ({ reqId, ok, reason }) => client.tools.confirm(reqId, ok, reason),

    // memory.userProfile
    'ai.memory.userProfile.get': () => profile(client.memory.userProfile.get()),
    'ai.memory.userProfile.set': async (patch) =>
      profile(
        await client.memory.userProfile.set(
          patch as Parameters<AIClient['memory']['userProfile']['set']>[0],
        ),
      ),
    'ai.memory.userProfile.reset': async () => profile(await client.memory.userProfile.reset()),
    'ai.memory.userProfile.export': async () => profile(await client.memory.userProfile.export()),
    'ai.memory.userProfile.import': async ({ data }) =>
      profile(await client.memory.userProfile.import(data)),

    // memory.facts
    'ai.memory.facts.list': () => client.memory.facts.list(),
    'ai.memory.facts.put': (fact) => client.memory.facts.put(fact),
    'ai.memory.facts.delete': ({ id }) => client.memory.facts.delete(id),

    // memory.summaries
    'ai.memory.summaries.get': ({ sessionId }) => client.memory.summaries.get(sessionId),
    'ai.memory.summaries.put': (summary) => client.memory.summaries.put(summary),

    // asr
    'ai.asr.list': () => client.asr.list(),
    'ai.asr.transcribe': async ({ pcm, opts: o }) =>
      withoutRaw(await client.asr.transcribe(pcm, o)),

    // tts
    'ai.tts.list': () => client.tts.list(),
    'ai.tts.listVoices': () => client.tts.listVoices(),
    'ai.tts.synth': ({ text, opts: o }) => client.tts.synth(text, o),
    'ai.tts.stream': ({ text, opts: o }) => batchTextChunks(client.tts.stream(text, o), batchMs),
    'ai.tts.stop': ({ reqId }) => client.tts.stop(reqId),

    // avatar（语义名；不在词表里的由 ctx.avatar 忽略）
    'ai.avatar.isAvailable': () => client.avatar.isAvailable(),
    'ai.avatar.emotion': ({ name, weight }) => client.avatar.emotion(name as never, weight),
    'ai.avatar.gesture': ({ name }) => client.avatar.gesture(name as never),
    'ai.avatar.activity': ({ name }) => client.avatar.activity(name as never),
    'ai.avatar.speaking': ({ level }) => client.avatar.speaking(level),
    'ai.avatar.report': (event) => client.avatar.report(event),
  };

  const disposers: Array<() => void> = [];
  const bindEvents = (publisher: EventPublisher<AppContract>): (() => void) => {
    if (opts.publishEvents === false) return () => undefined;
    const offs: Array<() => void> = [];
    for (const [evt, event] of Object.entries(AI_EVENTS) as Array<
      [AiClientEventName, (typeof AI_EVENTS)[AiClientEventName]]
    >) {
      const off = client.on(evt as AIClientEvent, (data: unknown) => {
        try {
          publisher.publish(event, data as never);
        } catch (err) {
          logger.warn(`publish ${event} failed`, err);
        }
        // 埋点在推送之后，避免副作用阻塞 IPC
        bridge?.notify(evt as AIClientEvent, data as never);
      });
      offs.push(off);
      disposers.push(off);
    }
    return () => {
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch (err) {
          logger.warn('event disposer threw', err);
        }
      }
    };
  };

  return {
    handlers,
    bindEvents,
    dispose() {
      for (const off of disposers.splice(0)) {
        try {
          off();
        } catch (err) {
          logger.warn('event disposer threw', err);
        }
      }
      for (const ctrl of streamAborts.values()) ctrl.abort();
      streamAborts.clear();
      bridge?.dispose();
    },
  };
}

/**
 * 只有 AI 门面的 router（测试与无界面宿主用）；契约里其余过程由 `extra.handlers` 补，缺的以 NOT_FOUND 失败。
 * Electron 宿主改用 `createAiHandlers` + 宿主的 `createAppRouter`（host-electron/src/host/contract）。
 */
export function createAiRouter(
  opts: AiRouterOptions,
  extra: AiRouterExtraOptions = {},
): AiRouterHandle {
  const ai = createAiHandlers(opts);
  const logger = opts.logger ?? ConsoleRuntimeLogger;
  const router = implement(
    appContract,
    { ...missingHandlers(), ...extra.handlers, ...ai.handlers } as Handlers<AppContract>,
    {
      middleware: extra.middleware,
      // 门面抛出的 AIClientError 把 code / retryable / hint 编在 message 里（`[CODE|1] …`），
      // 以 INTERNAL 的 message 原样传给视图，由 ai-sdk-client 的 SDKError.fromIpc 还原
      logger: { warn: (msg, data) => logger.warn(msg, data) },
    },
  );
  ai.bindEvents(router.events);
  return { router, dispose: () => ai.dispose() };
}

/** 契约里每个非 `ai.*` 过程的桩：调用时以 NOT_FOUND 失败 */
export function missingHandlers(): NonAiHandlers {
  const table: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(appContract.procedures)) {
    if (name.startsWith('ai.')) continue;
    const fail = (): never => {
      throw new ContractError('NOT_FOUND', `Procedure '${name}' is not available`);
    };
    table[name] =
      (def as { kind: string }).kind === 'stream'
        ? // eslint-disable-next-line require-yield -- 第一次 next() 就失败
          async function* () {
            fail();
          }
        : fail;
  }
  return table as NonAiHandlers;
}

/** UserProfile 是 interface：顶层 loose schema 需要索引签名，这里只放宽这一层 */
function profile<T extends object>(value: T): T & Record<string, unknown> {
  return value as T & Record<string, unknown>;
}

function isObservabilityBridge(value: unknown): value is ObservabilityBridge {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { notify?: unknown }).notify === 'function' &&
    typeof (value as { dispose?: unknown }).dispose === 'function'
  );
}

function resolveObservabilityBridge(
  input: AiRouterOptions['observability'],
): ObservabilityBridge | undefined {
  if (input === undefined || input === false) return undefined;
  if (input === true) return createObservabilityBridge();
  if (isObservabilityBridge(input)) return input;
  return createObservabilityBridge(input);
}
