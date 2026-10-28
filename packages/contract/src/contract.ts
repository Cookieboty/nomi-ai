/**
 * 契约定义（docs/design/core-host-decoupling.md §4.1）。
 *
 * 契约是视图与内核之间的唯一来源：过程（query / mutation / stream）+ 事件 + zod schema + 版本号。
 * 过程名用点分（`chat.stream`），客户端据此生成嵌套的 `api.chat.stream(...)`。
 */

import type { z } from 'zod';

import { BUILTIN_ERROR_CODES, type BuiltinErrorCode } from './errors';

/** 契约里使用的 schema：任意 zod 类型 */
export type Schema = z.ZodType;

/** 调用方所在的界面（§8） */
export type Surface = 'chat' | 'mascot' | 'settings' | 'test';

export const SURFACES: readonly Surface[] = Object.freeze(['chat', 'mascot', 'settings', 'test']);

export type ProcedureKind = 'query' | 'mutation' | 'stream';

interface ProcedureBase {
  /** 只接受 `trusted` 调用者（§8） */
  dangerous?: boolean;
  /** 允许调用的界面；不写 = 所有界面 */
  surfaces?: readonly Surface[];
  /** 已弃用：保留一个 minor 版本后删除（§4.3）；字符串写替代方案 */
  deprecated?: boolean | string;
  description?: string;
}

export interface QueryDef<
  I extends Schema = Schema,
  O extends Schema = Schema,
> extends ProcedureBase {
  kind: 'query';
  input: I;
  output: O;
}

export interface MutationDef<
  I extends Schema = Schema,
  O extends Schema = Schema,
> extends ProcedureBase {
  kind: 'mutation';
  input: I;
  output: O;
}

export interface StreamDef<
  I extends Schema = Schema,
  C extends Schema = Schema,
  O extends Schema = Schema,
> extends ProcedureBase {
  kind: 'stream';
  input: I;
  /** 每个 chunk 的 schema */
  chunk: C;
  /** 流结束时的结果；不写 = 无结果（void） */
  output?: O;
}

export type ProcedureDef = QueryDef | MutationDef | StreamDef;
export type ProcedureMap = Record<string, ProcedureDef>;
export type EventMap = Record<string, Schema>;

export interface ContractVersion {
  major: number;
  minor: number;
}

export interface Contract<
  P extends ProcedureMap = ProcedureMap,
  E extends EventMap = EventMap,
  Err extends string = string,
> {
  readonly version: ContractVersion;
  readonly procedures: P;
  readonly events: E;
  /** 业务错误码（内置错误码之外） */
  readonly errors: readonly Err[];
}

export type AnyContract = Contract<ProcedureMap, EventMap, string>;

export interface ContractDefinition<
  P extends ProcedureMap,
  E extends EventMap,
  Err extends string,
> {
  version: ContractVersion;
  procedures: P;
  events?: E;
  errors?: readonly Err[];
}

// ---------------------------------------------------------------------------
// 类型推导
// ---------------------------------------------------------------------------

/** 视图传入的参数类型（schema 的输入侧） */
export type InputOf<D> = D extends { input: infer S extends Schema } ? z.input<S> : never;
/** 处理函数收到的参数类型（schema 解析后） */
export type ParsedInputOf<D> = D extends { input: infer S extends Schema } ? z.output<S> : never;
/** 视图拿到的结果类型 */
export type OutputOf<D> = D extends { output: infer S extends Schema } ? z.output<S> : void;
/** 处理函数应返回的结果类型 */
export type HandlerOutputOf<D> = D extends { output: infer S extends Schema } ? z.input<S> : void;
/** 视图拿到的 chunk 类型 */
export type ChunkOf<D> = D extends { chunk: infer S extends Schema } ? z.output<S> : never;
/** 处理函数应产出的 chunk 类型 */
export type HandlerChunkOf<D> = D extends { chunk: infer S extends Schema } ? z.input<S> : never;

export type ProceduresOf<C extends AnyContract> = C['procedures'];
export type EventsOf<C extends AnyContract> = C['events'];
export type ProcedureName<C extends AnyContract> = keyof C['procedures'] & string;
export type EventName<C extends AnyContract> = keyof C['events'] & string;
export type EventData<C extends AnyContract, K extends EventName<C>> = z.output<C['events'][K]>;
export type EventInput<C extends AnyContract, K extends EventName<C>> = z.input<C['events'][K]>;

/** 契约可用的全部错误码：内置 + 契约声明 */
export type ErrorCodeOf<C extends AnyContract> =
  BuiltinErrorCode | (C extends Contract<ProcedureMap, EventMap, infer Err> ? Err : never);

// ---------------------------------------------------------------------------
// defineContract
// ---------------------------------------------------------------------------

/** 内置握手过程（§4.3）；契约里不得再定义 `meta.*` */
export const META_VERSION = 'meta.version';
const RESERVED_HEADS = new Set(['meta', 'on']);
/** 任何一段都不能用的名字：会污染原型或让 api 节点变成 thenable */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'then',
]);

/** 返回名字里第一个保留段，没有则返回 undefined */
export function findReservedSegment(name: string): string | undefined {
  return name.split('.').find((seg) => RESERVED_SEGMENTS.has(seg));
}
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const KINDS = new Set<ProcedureKind>(['query', 'mutation', 'stream']);

function assertVersion(v: ContractVersion): void {
  for (const part of [v?.major, v?.minor]) {
    if (!Number.isInteger(part) || (part as number) < 0) {
      throw new TypeError(
        `[contract] version must be { major, minor } with non-negative integers, got ${JSON.stringify(v)}`,
      );
    }
  }
}

function isSchema(value: unknown): value is Schema {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParseAsync?: unknown }).safeParseAsync === 'function'
  );
}

/**
 * 定义一份契约。运行时校验过程名（点分标识符、不与保留名冲突、不出现 `a` 与 `a.b` 同时存在），
 * 返回冻结的契约对象；类型上保留每个过程的 kind 与 schema，供 createClient / implement 推导。
 */
export function defineContract<
  const P extends ProcedureMap,
  const E extends EventMap = Record<never, Schema>,
  const Err extends string = never,
>(def: ContractDefinition<P, E, Err>): Contract<P, E, Err> {
  assertVersion(def.version);
  const procedures = def.procedures ?? ({} as P);
  const names = Object.keys(procedures);
  const nameSet = new Set(names);

  for (const name of names) {
    if (!NAME_RE.test(name)) {
      throw new TypeError(`[contract] invalid procedure name '${name}' (use dotted identifiers)`);
    }
    const head = name.split('.')[0] ?? name;
    if (RESERVED_HEADS.has(head) || head.startsWith('$')) {
      throw new TypeError(`[contract] procedure name '${name}' uses reserved namespace '${head}'`);
    }
    const reserved = findReservedSegment(name);
    if (reserved !== undefined) {
      throw new TypeError(
        `[contract] procedure name '${name}' uses reserved identifier '${reserved}'`,
      );
    }
    const segments = name.split('.');
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join('.');
      if (nameSet.has(prefix)) {
        throw new TypeError(
          `[contract] procedure '${prefix}' conflicts with namespace of '${name}'`,
        );
      }
    }
    const proc = procedures[name] as ProcedureDef;
    if (!proc || !KINDS.has(proc.kind)) {
      throw new TypeError(`[contract] procedure '${name}' has invalid kind`);
    }
    if (!isSchema(proc.input)) {
      throw new TypeError(`[contract] procedure '${name}' is missing an input schema`);
    }
    if (proc.kind === 'stream') {
      if (!isSchema(proc.chunk)) {
        throw new TypeError(`[contract] stream '${name}' is missing a chunk schema`);
      }
      if (proc.output !== undefined && !isSchema(proc.output)) {
        throw new TypeError(`[contract] stream '${name}' has an invalid output schema`);
      }
    } else if (!isSchema(proc.output)) {
      throw new TypeError(`[contract] procedure '${name}' is missing an output schema`);
    }
    if (proc.surfaces) {
      for (const s of proc.surfaces) {
        if (!SURFACES.includes(s)) {
          throw new TypeError(`[contract] procedure '${name}' has unknown surface '${s}'`);
        }
      }
    }
  }

  const events = (def.events ?? {}) as E;
  for (const [name, schema] of Object.entries(events)) {
    if (!NAME_RE.test(name)) {
      throw new TypeError(`[contract] invalid event name '${name}'`);
    }
    const reserved = findReservedSegment(name);
    if (reserved !== undefined) {
      throw new TypeError(`[contract] event name '${name}' uses reserved identifier '${reserved}'`);
    }
    if (!isSchema(schema)) {
      throw new TypeError(`[contract] event '${name}' is missing a schema`);
    }
  }

  const errors = [...new Set(def.errors ?? [])];
  for (const code of errors) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(code)) {
      throw new TypeError(`[contract] error code '${code}' must be UPPER_SNAKE_CASE`);
    }
    if ((BUILTIN_ERROR_CODES as readonly string[]).includes(code)) {
      throw new TypeError(`[contract] error code '${code}' is built in`);
    }
  }

  return Object.freeze({
    version: Object.freeze({ major: def.version.major, minor: def.version.minor }),
    procedures: Object.freeze({ ...procedures }) as P,
    events: Object.freeze({ ...events }) as E,
    errors: Object.freeze(errors) as readonly Err[],
  });
}

export function getProcedure(contract: AnyContract, name: string): ProcedureDef | undefined {
  return Object.prototype.hasOwnProperty.call(contract.procedures, name)
    ? contract.procedures[name]
    : undefined;
}

export function getEventSchema(contract: AnyContract, name: string): Schema | undefined {
  return Object.prototype.hasOwnProperty.call(contract.events, name)
    ? contract.events[name]
    : undefined;
}

/** 握手结果 */
export interface ServerInfo {
  version: ContractVersion;
  /** 线协议版本（protocol.ts） */
  protocol: number;
}

/** major 一致即兼容（§4.3）：minor 只增不删 */
export function isCompatible(a: ContractVersion, b: ContractVersion): boolean {
  return a.major === b.major;
}
