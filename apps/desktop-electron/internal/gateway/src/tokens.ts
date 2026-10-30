/**
 * count_tokens 的本地计算（docs/design/unified-gateway.md §10.3）。
 * 1. 用真实用量校准：按 (会话键, 供应商, 模型) 记住「消息前缀哈希 → 实测输入 token」，内存 LRU；
 * 2. count_tokens 到来时找共享最长前缀的已记录请求：实测值 + 估算(新增部分)；
 * 3. 没有可校准的记录时退回纯字符估算。结果都向上取 5%，宁可稍早压缩。
 */
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import { sessionKey } from './affinity';
import type { Wire } from './ir';
import type { StreamUsage } from './stream/events';

/** 纯字符估算：CJK 字符约 1.5 字/token，其余约 4 字符/token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0xac00 && c <= 0xd7af)
    )
      cjk++;
  }
  const rest = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.5 + rest / 4));
}

/** 向上取 5% */
const ROUND_UP = 1.05;

/** 整个请求体的估算（序列化后计数，含工具定义与 system） */
export function estimateRequestTokens(body: unknown): number {
  return Math.ceil(estimateTokens(JSON.stringify(body ?? {})) * ROUND_UP);
}

/* ------------------------------- 会话键 ------------------------------- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** 请求体里的消息列表键 */
function listKey(wire: Wire): 'messages' | 'input' | 'contents' {
  return wire === 'gemini' ? 'contents' : wire === 'responses' ? 'input' : 'messages';
}

/** 消息列表之外、对所有轮次都相同的部分（system、工具定义） */
function headOf(wire: Wire, b: Obj): unknown[] {
  if (wire === 'messages') return [b.system, b.tools];
  if (wire === 'responses') return [b.instructions, b.tools];
  if (wire === 'gemini') return [b.systemInstruction, b.tools];
  return [b.tools];
}

/** 会话键（与缓存亲和同一套规则，见 affinity.ts）；认不出时为空串 */
export function sessionKeyOf(
  wire: Wire,
  headers: Record<string, unknown> | undefined,
  body: unknown,
): string {
  return sessionKey(wire, (headers ?? {}) as IncomingHttpHeaders, body) ?? '';
}

/* ------------------------------- 前缀哈希 ------------------------------- */

interface Prefix {
  /** 第 i 项 = 前 i+1 个片段（片段 0 是 system + 工具，之后每条消息一个）的累积哈希 */
  hashes: string[];
  /** 每个片段的纯估算 */
  estimates: number[];
}

function prefixOf(wire: Wire, body: unknown): Prefix | null {
  if (!isObj(body)) return null;
  const list = body[listKey(wire)];
  const items: unknown[] = Array.isArray(list) ? list : list === undefined ? [] : [list];
  if (!items.length) return null;
  const parts = [headOf(wire, body), ...items];
  const hashes: string[] = [];
  const estimates: number[] = [];
  let h: string = wire;
  for (const p of parts) {
    const s = JSON.stringify(p ?? null);
    h = sha1(`${h}\n${s}`);
    hashes.push(h);
    estimates.push(estimateTokens(s));
  }
  return { hashes, estimates };
}

/* ------------------------------- 校准记录（LRU） ------------------------------- */

interface CalRecord {
  hashes: string[];
  inputTokens: number;
}

interface Slot {
  at: number;
  records: CalRecord[];
}

/** LRU 容量（会话 × 供应商 × 模型） */
const MAX_SLOTS = 500;
/** 记录有效期 */
const SLOT_TTL_MS = 30 * 60_000;
/** 每个会话保留的最近记录数（主对话、子代理、压缩请求交替时都能命中） */
const RECORDS_PER_SLOT = 8;

const slots = new Map<string, Slot>();

export interface CalibrationKey {
  sessionKey: string;
  providerId: string;
  model: string;
  /** 请求体的协议（入口协议） */
  wire: Wire;
}

const slotKey = (k: CalibrationKey) =>
  JSON.stringify([k.sessionKey, k.providerId, k.model, k.wire]);

function getSlot(key: string, now: number): Slot | undefined {
  const s = slots.get(key);
  if (!s) return undefined;
  if (now - s.at > SLOT_TTL_MS) {
    slots.delete(key);
    return undefined;
  }
  return s;
}

/**
 * 上游实际消耗的输入 token（含缓存读写）。
 * Anthropic 的 input_tokens 不含缓存部分，OpenAI / Gemini 的已含缓存命中（§9.4）。
 */
export function measuredInputTokens(upstreamWire: Wire, usage: StreamUsage | undefined): number {
  if (!usage) return 0;
  const input = usage.inputTokens ?? 0;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  return upstreamWire === 'messages' ? input + read + write : input + write;
}

/** 记下一次真实请求的实测输入 token（请求体按入口协议，inputTokens 含缓存读写） */
export function recordUsage(
  k: CalibrationKey & { body: unknown; inputTokens: number; now?: number },
): void {
  if (!(k.inputTokens > 0)) return;
  const p = prefixOf(k.wire, k.body);
  if (!p) return;
  const now = k.now ?? Date.now();
  const key = slotKey(k);
  const slot = getSlot(key, now) ?? { at: now, records: [] };
  const full = p.hashes[p.hashes.length - 1];
  slot.records = slot.records.filter((r) => r.hashes[r.hashes.length - 1] !== full);
  slot.records.push({ hashes: p.hashes, inputTokens: k.inputTokens });
  if (slot.records.length > RECORDS_PER_SLOT) slot.records.shift();
  slot.at = now;
  slots.delete(key);
  slots.set(key, slot);
  while (slots.size > MAX_SLOTS) slots.delete(slots.keys().next().value!);
}

/**
 * count_tokens 的本地结果：已记录请求里，整个请求是本次请求前缀的那条中最长的一条，
 * 结果 = 实测值 + 估算(新增部分)；找不到时退回纯估算。都向上取 5%。
 */
export function calibratedCount(k: CalibrationKey & { body: unknown; now?: number }): number {
  const p = prefixOf(k.wire, k.body);
  const now = k.now ?? Date.now();
  const key = slotKey(k);
  const slot = p ? getSlot(key, now) : undefined;
  let best: CalRecord | undefined;
  if (p && slot) {
    for (const r of slot.records) {
      const n = r.hashes.length;
      if (n > p.hashes.length || r.hashes[n - 1] !== p.hashes[n - 1]) continue;
      if (!best || n > best.hashes.length) best = r;
    }
  }
  if (!p || !best || !slot) return estimateRequestTokens(k.body);
  slot.at = now;
  slots.delete(key);
  slots.set(key, slot);
  const suffix = p.estimates.slice(best.hashes.length).reduce((a, b) => a + b, 0);
  return Math.ceil((best.inputTokens + suffix) * ROUND_UP);
}

/** 测试用：清空校准记录 */
export function resetCalibration(): void {
  slots.clear();
}
