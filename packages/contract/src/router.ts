/**
 * 内核侧：`implement(contract, handlers)` → Router（docs/design/core-host-decoupling.md §4.1、§8）。
 *
 * - 处理函数表按契约推导：缺过程、多过程、参数或返回值类型不符都会编译失败；
 * - 调用链：内置守卫（surfaces / dangerous）→ 入参校验 → 中间件（洋葱模型）→ 处理函数 → 出参校验；
 * - `ctx.events.publish` 按契约事件表做类型与 schema 校验，内核不知道窗口，由传输层按订阅推送（§5.3）。
 */

import type { z } from 'zod';

import {
  getEventSchema,
  getProcedure,
  META_VERSION,
  type AnyContract,
  type ErrorCodeOf,
  type EventInput,
  type EventName,
  type HandlerChunkOf,
  type HandlerOutputOf,
  type ParsedInputOf,
  type ProcedureDef,
  type ProcedureKind,
  type Schema,
  type ServerInfo,
  type Surface,
} from './contract';
import { abortedError, ContractError } from './errors';
import { PROTOCOL_VERSION } from './protocol';
import type { ContractLogger } from './transport';

/** 调用者信息（§8）：由传输层填写，router 中间件据此判定 */
export interface CallerContext {
  surface: Surface;
  /** 宿主确认来源是自家页面 */
  trusted: boolean;
  /** 传输层给的连接标识（窗口 id、WebSocket 连接号…），仅用于日志与限流 */
  id?: string;
}

export interface EventPublisher<C extends AnyContract> {
  publish<K extends EventName<C>>(event: K, data: EventInput<C, K>): void;
}

export interface HandlerContext<C extends AnyContract> {
  name: string;
  caller: CallerContext;
  /** 调用方取消（abort 帧、连接断开）时触发 */
  signal: AbortSignal;
  events: EventPublisher<C>;
  /** 抛出契约错误；错误码限于内置码与契约 `errors` */
  fail(code: ErrorCodeOf<C>, message: string, data?: unknown): never;
}

type StreamHandlerReturn<D> =
  | AsyncGenerator<HandlerChunkOf<D>, HandlerOutputOf<D>, unknown>
  | (void extends HandlerOutputOf<D> ? AsyncIterable<HandlerChunkOf<D>> : never);

export type HandlerFor<D, C extends AnyContract> = D extends { kind: 'stream' }
  ? (input: ParsedInputOf<D>, ctx: HandlerContext<C>) => StreamHandlerReturn<D>
  : (
      input: ParsedInputOf<D>,
      ctx: HandlerContext<C>,
    ) => Promise<HandlerOutputOf<D>> | HandlerOutputOf<D>;

export type Handlers<C extends AnyContract> = {
  [K in keyof C['procedures']]: HandlerFor<C['procedures'][K], C>;
};

/** 中间件看到的调用信息；`input` 已通过入参校验 */
export interface CallInfo {
  name: string;
  kind: ProcedureKind;
  procedure: ProcedureDef;
  input: unknown;
  caller: CallerContext;
  signal: AbortSignal;
}

/**
 * 中间件：洋葱模型。query / mutation 的 `next()` 得到处理结果；
 * stream 的 `next()` 得到流的迭代器（中间件只适合做前置检查、计时、日志）。
 */
export type Middleware = (call: CallInfo, next: () => Promise<unknown>) => Promise<unknown>;

export interface ValidationOptions {
  /** 校验入参（默认 true；入参来自视图，不可信，不建议关闭） */
  input?: boolean;
  /** 校验返回值与 chunk（默认 true） */
  output?: boolean;
  /** 校验 publish 的事件（默认 true） */
  events?: boolean;
}

export interface ImplementOptions {
  middleware?: readonly Middleware[];
  validate?: ValidationOptions;
  logger?: ContractLogger;
}

export interface InvokeOptions {
  caller: CallerContext;
  signal?: AbortSignal;
}

export interface RouterEvents<C extends AnyContract> extends EventPublisher<C> {
  /** 传输层订阅事件（已校验后的数据） */
  subscribe(event: string, fn: (data: unknown) => void): () => void;
  has(event: string): boolean;
  /**
   * 现在订阅了这个事件的监听者数（传输层每个订阅了的窗口一个）。发布方据此判断事件有没有送达：
   * 例如对话窗口还没挂载时发的面板导航由内核留着，等窗口挂载后拉取
   */
  subscribers(event: string): number;
}

export interface Router<C extends AnyContract = AnyContract> {
  readonly contract: C;
  /** query / mutation，以及内置的 `meta.version` */
  call(name: string, input: unknown, opts: InvokeOptions): Promise<unknown>;
  /** stream：迭代器的 done 值是流的最终结果 */
  stream(
    name: string,
    input: unknown,
    opts: InvokeOptions,
  ): Promise<AsyncIterator<unknown, unknown>>;
  readonly events: RouterEvents<C>;
}

function issuesOf(error: z.ZodError): Array<{ path: Array<string | number>; message: string }> {
  return error.issues.map((i) => ({
    path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
    message: i.message,
  }));
}

async function parseWith(
  schema: Schema,
  value: unknown,
  code: 'BAD_INPUT' | 'BAD_OUTPUT',
  what: string,
): Promise<unknown> {
  const r = await schema.safeParseAsync(value);
  if (!r.success) {
    throw new ContractError(code, `Invalid ${what}`, { issues: issuesOf(r.error) });
  }
  return r.data;
}

const NEVER_ABORTED = new AbortController().signal;

const handshakeInput = {
  parse(input: unknown): { major: number; minor: number } | undefined {
    if (input === undefined || input === null) return undefined;
    const v = input as { major?: unknown; minor?: unknown };
    if (typeof v === 'object' && Number.isInteger(v.major) && Number.isInteger(v.minor)) {
      return { major: v.major as number, minor: v.minor as number };
    }
    throw new ContractError('BAD_INPUT', 'Invalid handshake input');
  },
};

/** 内置守卫（§8）：surfaces 白名单与 dangerous 过程只接受 trusted 调用者。不可关闭。 */
function guard(name: string, def: ProcedureDef, caller: CallerContext | undefined): void {
  if (!caller) throw new ContractError('FORBIDDEN', `No caller for '${name}'`);
  if (def.surfaces && !def.surfaces.includes(caller.surface)) {
    throw new ContractError('FORBIDDEN', `Surface '${caller.surface}' may not call '${name}'`, {
      surface: caller.surface,
    });
  }
  if (def.dangerous && !caller.trusted) {
    throw new ContractError('FORBIDDEN', `Untrusted caller may not call dangerous '${name}'`, {
      dangerous: true,
    });
  }
}

/**
 * 用处理函数表实现契约，得到 Router。处理函数表的类型由契约推导：
 * 少写、多写、写错参数或返回值类型都是编译错误。
 */
export function implement<C extends AnyContract>(
  contract: C,
  handlers: Handlers<C>,
  options: ImplementOptions = {},
): Router<C> {
  const validateInput = options.validate?.input !== false;
  const validateOutput = options.validate?.output !== false;
  const validateEvents = options.validate?.events !== false;
  const middleware = [...(options.middleware ?? [])];
  const logger = options.logger;
  const table = handlers as unknown as Record<string, (input: unknown, ctx: unknown) => unknown>;

  for (const name of Object.keys(contract.procedures)) {
    if (typeof table[name] !== 'function') {
      throw new TypeError(`[contract] missing handler for '${name}'`);
    }
  }
  for (const name of Object.keys(table)) {
    if (!getProcedure(contract, name)) {
      throw new TypeError(`[contract] handler '${name}' is not declared in the contract`);
    }
  }

  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const events: RouterEvents<C> = {
    publish(event, data) {
      const schema = getEventSchema(contract, event);
      if (!schema) throw new ContractError('NOT_FOUND', `Event '${event}' is not declared`);
      let value: unknown = data;
      if (validateEvents) {
        const r = schema.safeParse(data);
        if (!r.success) {
          throw new ContractError('BAD_OUTPUT', `Invalid event '${event}'`, {
            issues: issuesOf(r.error),
          });
        }
        value = r.data;
      }
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(value);
        } catch (err) {
          logger?.warn(`[contract] event listener for '${event}' threw`, err);
        }
      }
    },
    subscribe(event, fn) {
      if (!getEventSchema(contract, event)) {
        throw new ContractError('NOT_FOUND', `Event '${event}' is not declared`);
      }
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0 && listeners.get(event) === set) listeners.delete(event);
      };
    },
    has(event) {
      return getEventSchema(contract, event) !== undefined;
    },
    subscribers(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
  const publisher: EventPublisher<C> = { publish: events.publish };

  const fail = (code: string, message: string, data?: unknown): never => {
    throw new ContractError(code, message, data);
  };

  async function run(
    name: string,
    expected: 'call' | 'stream',
    rawInput: unknown,
    opts: InvokeOptions,
  ): Promise<unknown> {
    const def = getProcedure(contract, name);
    if (!def) throw new ContractError('NOT_FOUND', `Procedure '${name}' not found`);
    if ((def.kind === 'stream') !== (expected === 'stream')) {
      throw new ContractError(
        'BAD_REQUEST',
        `Procedure '${name}' is a ${def.kind}; use ${def.kind === 'stream' ? 'stream' : 'call'}`,
      );
    }
    guard(name, def, opts.caller);
    const signal = opts.signal ?? NEVER_ABORTED;
    if (signal.aborted) throw abortedError();
    const input = validateInput
      ? await parseWith(def.input, rawInput, 'BAD_INPUT', 'input')
      : rawInput;

    const info: CallInfo = {
      name,
      kind: def.kind,
      procedure: def,
      input,
      caller: opts.caller,
      signal,
    };
    const ctx: HandlerContext<C> = {
      name,
      caller: opts.caller,
      signal,
      events: publisher,
      fail: fail as HandlerContext<C>['fail'],
    };
    const handler = table[name] as (input: unknown, ctx: unknown) => unknown;

    const terminal = async (): Promise<unknown> => {
      if (def.kind === 'stream') {
        const source = handler(info.input, ctx) as AsyncIterable<unknown>;
        if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
          throw new ContractError('INTERNAL', `Handler '${name}' did not return an async iterable`);
        }
        return wrapStream(def.chunk, def.output, source, validateOutput);
      }
      const out = await handler(info.input, ctx);
      return validateOutput ? parseWith(def.output, out, 'BAD_OUTPUT', `output of '${name}'`) : out;
    };

    const dispatch = (i: number): Promise<unknown> => {
      const mw = middleware[i];
      if (!mw) return terminal();
      let called = false;
      return mw(info, () => {
        if (called) return Promise.reject(new Error('[contract] next() called twice'));
        called = true;
        return dispatch(i + 1);
      });
    };
    return dispatch(0);
  }

  const router: Router<C> = {
    contract,
    async call(name, input, opts) {
      if (name === META_VERSION) {
        const client = handshakeInput.parse(input);
        if (client && client.major !== contract.version.major) {
          throw new ContractError(
            'VERSION_MISMATCH',
            `Contract major mismatch: client ${client.major}.${client.minor}, server ${contract.version.major}.${contract.version.minor}`,
            { client, server: { ...contract.version } },
          );
        }
        const info: ServerInfo = { version: { ...contract.version }, protocol: PROTOCOL_VERSION };
        return info;
      }
      return run(name, 'call', input, opts);
    },
    async stream(name, input, opts) {
      return (await run(name, 'stream', input, opts)) as AsyncIterator<unknown, unknown>;
    },
    events,
  };
  return router;
}

function wrapStream(
  chunkSchema: Schema,
  outputSchema: Schema | undefined,
  source: AsyncIterable<unknown>,
  validate: boolean,
): AsyncIterator<unknown, unknown> {
  const it = source[Symbol.asyncIterator]();
  return {
    async next() {
      const r = await it.next();
      if (r.done) {
        const value =
          validate && outputSchema
            ? await parseWith(outputSchema, r.value, 'BAD_OUTPUT', 'stream output')
            : outputSchema
              ? r.value
              : undefined;
        return { done: true, value };
      }
      const value = validate
        ? await parseWith(chunkSchema, r.value, 'BAD_OUTPUT', 'chunk')
        : r.value;
      return { done: false, value };
    },
    async return(value?: unknown) {
      await it.return?.();
      return { done: true, value };
    },
  };
}
