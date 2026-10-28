/**
 * 视图侧：`createClient(contract, transport)` → 类型化的 api（docs/design/core-host-decoupling.md §4.1）。
 *
 *   const api = createClient(contract, transport);
 *   await api.sessions.list();
 *   for await (const chunk of api.chat.stream(input, { signal })) …
 *   const off = api.on('usage.updated', (u) => …);
 *
 * 握手（§4.3）：默认第一次调用前自动调用 `meta.version`，major 不一致时所有调用都以
 * VERSION_MISMATCH 失败，不进入半可用状态；也可以 `handshake: 'manual'` 后自己 `await api.$connect()`。
 * 'auto' 模式下握手成功之前收到的事件先缓存（每个监听最多 EVENT_BUFFER_LIMIT 条），
 * 握手成功后按顺序投递，major 不一致时丢弃。
 */

import type { z } from 'zod';

import {
  findReservedSegment,
  getEventSchema,
  getProcedure,
  META_VERSION,
  type AnyContract,
  type ChunkOf,
  type ContractVersion,
  type EventData,
  type EventName,
  type InputOf,
  type OutputOf,
  type ProcedureDef,
  type Schema,
  type ServerInfo,
} from './contract';
import { abortedError, ContractError } from './errors';
import { PushStream, type ContractStream } from './stream';
import type { CallOptions, ClientTransport, ContractLogger } from './transport';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

type OptionalIfVoid<I> = undefined extends I
  ? [input?: I, opts?: CallOptions]
  : [input: I, opts?: CallOptions];

export type ClientMethod<D> = D extends { kind: 'stream' }
  ? (...args: OptionalIfVoid<InputOf<D>>) => ContractStream<ChunkOf<D>, OutputOf<D>>
  : (...args: OptionalIfVoid<InputOf<D>>) => Promise<OutputOf<D>>;

type Head<K extends string> = K extends `${infer H}.${string}` ? H : K;
type Tail<K extends string, H extends string> = K extends `${H}.${infer R}` ? R : never;

/** 点分过程名 → 嵌套对象：`'chat.stream'` → `api.chat.stream` */
export type ApiOf<P> = {
  [H in Head<keyof P & string>]: H extends keyof P
    ? ClientMethod<P[H]>
    : ApiOf<{ [K in keyof P & string as Tail<K, H>]: P[K] }>;
};

export interface ClientHelpers<C extends AnyContract> {
  /** 订阅事件；返回退订函数 */
  on<K extends EventName<C>>(event: K, fn: (data: EventData<C, K>) => void): () => void;
  /** 握手：major 不一致时以 VERSION_MISMATCH 失败；结果会缓存 */
  $connect(): Promise<ServerInfo>;
  readonly $contract: C;
  /** 关闭底层传输（若支持） */
  $close(): void;
}

export type Client<C extends AnyContract> = ApiOf<C['procedures']> & ClientHelpers<C>;

export interface ClientOptions {
  /** 'auto'（默认）：第一次调用前自动握手；'manual'：调用方自己 `$connect()`；'off'：不握手 */
  handshake?: 'auto' | 'manual' | 'off';
  validate?: {
    /** 发出前校验入参（默认 true） */
    input?: boolean;
    /** 校验结果与 chunk（默认 true） */
    output?: boolean;
    /** 校验收到的事件（默认 true；不合法的事件丢弃并 warn） */
    events?: boolean;
  };
  logger?: ContractLogger;
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

async function check(
  schema: Schema,
  value: unknown,
  code: 'BAD_INPUT' | 'BAD_OUTPUT',
  what: string,
): Promise<unknown> {
  const r = await schema.safeParseAsync(value);
  if (!r.success) {
    throw new ContractError(code, `Invalid ${what}`, {
      issues: (r.error as z.ZodError).issues.map((i) => ({
        path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
        message: i.message,
      })),
    });
  }
  return r.data;
}

/** 'auto' 握手完成前每个事件监听最多缓存的事件数，超出丢弃最早的 */
const EVENT_BUFFER_LIMIT = 256;

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function isServerInfo(v: unknown): v is ServerInfo {
  const o = v as { version?: Partial<ContractVersion>; protocol?: unknown } | null;
  return (
    typeof o === 'object' &&
    o !== null &&
    Number.isInteger(o.version?.major) &&
    Number.isInteger(o.version?.minor) &&
    typeof o.protocol === 'number'
  );
}

export function createClient<C extends AnyContract>(
  contract: C,
  transport: ClientTransport,
  options: ClientOptions = {},
): Client<C> {
  const mode = options.handshake ?? 'auto';
  const validateInput = options.validate?.input !== false;
  const validateOutput = options.validate?.output !== false;
  const validateEvents = options.validate?.events !== false;
  const logger = options.logger;
  const warnedDeprecated = new Set<string>();

  let connecting: Promise<ServerInfo> | null = null;
  /** 握手确认 major 不一致：之后的事件一律丢弃，不进入半可用状态 */
  let mismatched = false;
  /** 握手已成功（'auto' 模式下此前收到的事件先缓存） */
  let handshaken = false;
  /** 'auto' 模式下等待握手的事件缓存：握手成功时 flush，major 不一致时 drop */
  const waiting = new Set<{ flush(): void; drop(): void }>();
  const connect = (): Promise<ServerInfo> => {
    if (connecting) return connecting;
    const attempt = (async () => {
      const info = await transport.call(META_VERSION, { ...contract.version });
      if (!isServerInfo(info)) {
        throw new ContractError('VERSION_MISMATCH', 'Server did not answer the handshake');
      }
      if (info.version.major !== contract.version.major) {
        throw new ContractError(
          'VERSION_MISMATCH',
          `Contract major mismatch: client ${contract.version.major}.${contract.version.minor}, server ${info.version.major}.${info.version.minor}`,
          { client: { ...contract.version }, server: info.version },
        );
      }
      if (!handshaken) {
        handshaken = true;
        const pending = [...waiting];
        waiting.clear();
        for (const w of pending) w.flush();
      }
      return info;
    })();
    connecting = attempt;
    // 版本不一致是确定的结论，缓存失败；传输类失败允许下次重试
    attempt.catch((err) => {
      if (err instanceof ContractError && err.code === 'VERSION_MISMATCH') {
        mismatched = true;
        const pending = [...waiting];
        waiting.clear();
        for (const w of pending) w.drop();
      } else if (connecting === attempt) connecting = null;
    });
    return attempt;
  };
  const ready = (): Promise<unknown> => (mode === 'auto' ? connect() : Promise.resolve());

  const noteDeprecated = (name: string, def: ProcedureDef): void => {
    if (!def.deprecated || warnedDeprecated.has(name)) return;
    warnedDeprecated.add(name);
    const hint = typeof def.deprecated === 'string' ? `: ${def.deprecated}` : '';
    logger?.warn(`[contract] '${name}' is deprecated${hint}`);
  };

  const callProcedure = async (
    name: string,
    def: ProcedureDef,
    input: unknown,
    opts?: CallOptions,
  ): Promise<unknown> => {
    noteDeprecated(name, def);
    if (opts?.signal?.aborted) throw abortedError();
    const payload = validateInput ? await check(def.input, input, 'BAD_INPUT', 'input') : input;
    await ready();
    if (opts?.signal?.aborted) throw abortedError();
    const out = await transport.call(name, payload, opts);
    if (!validateOutput || def.kind === 'stream') return out;
    return check(def.output, out, 'BAD_OUTPUT', `output of '${name}'`);
  };

  const streamProcedure = (
    name: string,
    def: Extract<ProcedureDef, { kind: 'stream' }>,
    input: unknown,
    opts?: CallOptions,
  ): ContractStream<unknown, unknown> => {
    noteDeprecated(name, def);
    const local = new AbortController();
    const out = new PushStream<unknown, unknown>(() => local.abort());
    const userSignal = opts?.signal;
    const onUserAbort = () => {
      out.fail(abortedError());
      local.abort();
    };
    if (userSignal?.aborted) {
      out.fail(abortedError());
      return out;
    }
    userSignal?.addEventListener('abort', onUserAbort, { once: true });

    void (async () => {
      try {
        const payload = validateInput ? await check(def.input, input, 'BAD_INPUT', 'input') : input;
        await ready();
        if (local.signal.aborted) return;
        const inner = transport.stream(name, payload, { signal: local.signal });
        for await (const chunk of inner) {
          if (out.closed) return;
          out.push(validateOutput ? await check(def.chunk, chunk, 'BAD_OUTPUT', 'chunk') : chunk);
        }
        const result = await inner.result;
        out.end(
          validateOutput && def.output
            ? await check(def.output, result, 'BAD_OUTPUT', `output of '${name}'`)
            : def.output
              ? result
              : undefined,
        );
      } catch (err) {
        out.fail(err);
        // 本地校验失败（如 chunk 不合法）时让服务端也停下
        local.abort();
      } finally {
        userSignal?.removeEventListener('abort', onUserAbort);
      }
    })();
    return out;
  };

  // 嵌套节点用无原型对象，并且只认自有属性：过程名里的任何一段都不可能写到原型上
  const api: Record<string, unknown> = {};
  const nodes: Record<string, unknown>[] = [];
  for (const name of Object.keys(contract.procedures)) {
    const def = getProcedure(contract, name) as ProcedureDef;
    const reserved = findReservedSegment(name);
    if (reserved !== undefined) {
      throw new TypeError(
        `[contract] procedure name '${name}' uses reserved identifier '${reserved}'`,
      );
    }
    const segments = name.split('.');
    let node = api;
    for (const seg of segments.slice(0, -1)) {
      let child = hasOwn(node, seg) ? node[seg] : undefined;
      if (child === undefined) {
        child = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(node, seg, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        nodes.push(child as Record<string, unknown>);
      } else if (typeof child !== 'object' || child === null) {
        throw new TypeError(`[contract] procedure '${name}' conflicts with another procedure`);
      }
      node = child as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1] as string;
    if (hasOwn(node, leaf)) {
      throw new TypeError(`[contract] procedure '${name}' conflicts with another procedure`);
    }
    Object.defineProperty(node, leaf, {
      value:
        def.kind === 'stream'
          ? (input?: unknown, opts?: CallOptions) => streamProcedure(name, def, input, opts)
          : (input?: unknown, opts?: CallOptions) => callProcedure(name, def, input, opts),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  for (const n of nodes) Object.freeze(n);

  const helpers: ClientHelpers<C> = {
    on(event, fn) {
      const schema = getEventSchema(contract, event);
      if (!schema) throw new ContractError('NOT_FOUND', `Event '${event}' is not declared`);
      const deliver = (data: unknown): void => {
        if (mismatched) return;
        if (!validateEvents) {
          fn(data as EventData<C, typeof event>);
          return;
        }
        const r = schema.safeParse(data);
        if (!r.success) {
          logger?.warn(`[contract] dropped invalid event '${event}'`);
          return;
        }
        fn(r.data as EventData<C, typeof event>);
      };
      if (mode !== 'auto') return transport.subscribe(event, deliver);

      // 'auto'：握手成功前不投递事件，先缓存；major 不一致时丢弃
      const buffer: unknown[] = [];
      let active = true;
      const waiter = {
        flush() {
          const items = buffer.splice(0);
          for (const data of items) {
            if (!active) return;
            try {
              deliver(data);
            } catch (err) {
              logger?.warn(`[contract] listener for '${event}' threw`, err);
            }
          }
        },
        drop() {
          buffer.length = 0;
        },
      };
      const off = transport.subscribe(event, (data) => {
        if (mismatched || !active) return;
        if (handshaken) {
          deliver(data);
          return;
        }
        if (buffer.length >= EVENT_BUFFER_LIMIT) {
          buffer.shift();
          logger?.warn(`[contract] event buffer for '${event}' is full; dropped the oldest`);
        }
        buffer.push(data);
        waiting.add(waiter);
      });
      if (!handshaken) connect().catch(() => {});
      return () => {
        if (!active) return;
        active = false;
        buffer.length = 0;
        waiting.delete(waiter);
        off();
      };
    },
    $connect: connect,
    $contract: contract,
    $close() {
      transport.close?.();
    },
  };
  Object.assign(api, helpers);
  return Object.freeze(api) as unknown as Client<C>;
}
