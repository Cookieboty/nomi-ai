/**
 * 线协议（docs/design/core-host-decoupling.md §4.2）：所有帧都是可序列化的普通对象，
 * 可以原样走 Electron IPC、MessagePort 或 WebSocket（JSON + Uint8Array）。
 *
 * 客户端 → 服务端
 *   req    { t: 'req', id, kind: 'call' | 'stream', name, input }
 *   abort  { t: 'abort', id }                     取消进行中的调用 / 流
 *   sub    { t: 'sub', event } / unsub            订阅 / 退订事件
 *
 * 服务端 → 客户端
 *   res    { t: 'res', id, output }               query / mutation 的结果
 *   chunk  { t: 'chunk', id, data }               流的一个片段
 *   end    { t: 'end', id, output }               流正常结束（带最终结果）
 *   err    { t: 'err', id, error: { code, message, data? } }
 *   event  { t: 'event', event, data }
 *
 * 握手不是单独的帧：客户端调用内置过程 `meta.version`。
 */

import { z } from 'zod';

import type { ErrorPayload } from './errors';

/** 线协议版本；帧格式不兼容地变化时加一 */
export const PROTOCOL_VERSION = 1;

export type RequestKind = 'call' | 'stream';

export interface RequestFrame {
  t: 'req';
  id: string;
  kind: RequestKind;
  name: string;
  input?: unknown;
}
export interface AbortFrame {
  t: 'abort';
  id: string;
}
export interface SubscribeFrame {
  t: 'sub' | 'unsub';
  event: string;
}
export type ClientFrame = RequestFrame | AbortFrame | SubscribeFrame;

export interface ResultFrame {
  t: 'res';
  id: string;
  output?: unknown;
}
export interface ChunkFrame {
  t: 'chunk';
  id: string;
  data?: unknown;
}
export interface EndFrame {
  t: 'end';
  id: string;
  output?: unknown;
}
export interface ErrorFrame {
  t: 'err';
  id: string;
  error: ErrorPayload;
}
export interface EventFrame {
  t: 'event';
  event: string;
  data?: unknown;
}
export type ServerFrame = ResultFrame | ChunkFrame | EndFrame | ErrorFrame | EventFrame;

const id = z.string().min(1).max(128);
const name = z.string().min(1).max(256);

const errorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
});

/** 服务端用它校验入站帧（来自渲染进程 / 网络，不可信） */
export const clientFrameSchema: z.ZodType<ClientFrame> = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('req'),
    id,
    kind: z.enum(['call', 'stream']),
    name,
    input: z.unknown().optional(),
  }),
  z.object({ t: z.literal('abort'), id }),
  z.object({ t: z.enum(['sub', 'unsub']), event: name }),
]) as z.ZodType<ClientFrame>;

export const serverFrameSchema: z.ZodType<ServerFrame> = z.discriminatedUnion('t', [
  z.object({ t: z.literal('res'), id, output: z.unknown().optional() }),
  z.object({ t: z.literal('chunk'), id, data: z.unknown().optional() }),
  z.object({ t: z.literal('end'), id, output: z.unknown().optional() }),
  z.object({ t: z.literal('err'), id, error: errorPayloadSchema }),
  z.object({ t: z.literal('event'), event: name, data: z.unknown().optional() }),
]) as z.ZodType<ServerFrame>;

// ---------------------------------------------------------------------------
// 可序列化检查
// ---------------------------------------------------------------------------

/**
 * 检查一个值能否原样过线：只允许 JSON 能表达的值（null、布尔、有限数字、字符串、数组、普通对象）、
 * `undefined`（对象字段 / 可选值）与 `Uint8Array`。函数、class 实例、Map / Set / Date、bigint、symbol、
 * NaN / Infinity、循环引用都不允许。返回第一个违规位置的描述，合法时返回 null。
 */
export function findUnserializable(value: unknown, path = '$'): string | null {
  return walk(value, path, new Set());
}

function walk(value: unknown, path: string, seen: Set<object>): string | null {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null;
    case 'number':
      return Number.isFinite(value) ? null : `${path}: non-finite number`;
    case 'bigint':
    case 'symbol':
    case 'function':
      return `${path}: ${typeof value} is not serializable`;
    default:
      break;
  }
  const obj = value as object;
  if (obj instanceof Uint8Array) return null;
  if (seen.has(obj)) return `${path}: circular reference`;
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const bad = walk(obj[i], `${path}[${i}]`, seen);
        if (bad) return bad;
      }
      return null;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      const ctor = (proto as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown';
      return `${path}: ${ctor} instance is not serializable`;
    }
    for (const key of Object.keys(obj)) {
      const bad = walk((obj as Record<string, unknown>)[key], `${path}.${key}`, seen);
      if (bad) return bad;
    }
    return null;
  } finally {
    seen.delete(obj);
  }
}

export function isSerializable(value: unknown): boolean {
  return findUnserializable(value) === null;
}
