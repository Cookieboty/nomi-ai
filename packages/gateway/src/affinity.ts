/**
 * 缓存亲和（docs/design/unified-gateway.md §11.2，简化版）。
 * 同一个会话尽量留在上次成功的 (供应商, Key) 上，上游的提示缓存才命中得了。
 * 会话键：prompt_cache_key（Codex）→ x-claude-code-session-id 头 / metadata.user_id 里的 session_id（Claude Code）
 * → x-nomi-tab 头 → hash(system + 第一条 user 消息)。碰撞的后果只是排序偏好不准。
 */
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type { Wire } from './ir';

export const AFFINITY_MAX = 1000;
export const AFFINITY_TTL_MS = 30 * 60_000;

export interface AffinityTarget {
  providerId: string;
  keyId: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const header = (h: IncomingHttpHeaders, name: string) => {
  const v = h[name];
  return str(Array.isArray(v) ? v[0] : v);
};

/** Claude Code 的 metadata.user_id：新版是 JSON 字符串（带 session_id），旧版是普通字符串 */
function claudeUserSession(userId: string): string {
  try {
    const j = JSON.parse(userId) as { session_id?: unknown };
    const sid = j && typeof j === 'object' ? str(j.session_id) : null;
    if (sid) return sid;
  } catch {
    /* 旧版格式 */
  }
  const m = /session_([0-9a-f-]{8,})/i.exec(userId);
  return m ? m[1]! : userId;
}

function systemOf(wire: Wire, b: Record<string, unknown>): unknown {
  if (wire === 'messages') return b.system ?? null;
  if (wire === 'responses') return b.instructions ?? null;
  if (wire === 'gemini') return b.systemInstruction ?? b.system_instruction ?? null;
  const msgs = Array.isArray(b.messages) ? (b.messages as Array<Record<string, unknown>>) : [];
  return msgs.find((m) => m?.role === 'system' || m?.role === 'developer')?.content ?? null;
}

function firstUserOf(wire: Wire, b: Record<string, unknown>): unknown {
  if (wire === 'responses') {
    if (typeof b.input === 'string') return b.input;
    const items = Array.isArray(b.input) ? (b.input as Array<Record<string, unknown>>) : [];
    return items.find((m) => m?.role === 'user')?.content ?? null;
  }
  if (wire === 'gemini') {
    const cs = Array.isArray(b.contents) ? (b.contents as Array<Record<string, unknown>>) : [];
    return cs.find((m) => !m?.role || m.role === 'user')?.parts ?? null;
  }
  const msgs = Array.isArray(b.messages) ? (b.messages as Array<Record<string, unknown>>) : [];
  return msgs.find((m) => m?.role === 'user')?.content ?? null;
}

/** 会话键；什么都认不出（连 user 消息都没有）时返回 null，不做亲和 */
export function sessionKey(
  wire: Wire,
  headers: IncomingHttpHeaders,
  body: unknown,
  client = '',
  opts: { hashFallback?: boolean } = {},
): string | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  // 带客户端前缀（亲和 / 归属表按客户端分开）；不传客户端时不带前缀
  client = client ? `${client}:` : '';
  const pck = str(b.prompt_cache_key);
  if (pck) return `${client}pck:${pck}`;
  const cc = header(headers, 'x-claude-code-session-id');
  if (cc) return `${client}cc:${cc}`;
  const meta =
    b.metadata && typeof b.metadata === 'object' ? (b.metadata as Record<string, unknown>) : null;
  const uid = str(meta?.user_id);
  if (uid) return `${client}cc:${claudeUserSession(uid)}`;
  const tab = header(headers, 'x-nomi-tab');
  if (tab) return `${client}tab:${tab}`;
  if (opts.hashFallback === false) return null;
  const user = firstUserOf(wire, b);
  if (user === null || user === undefined) return null;
  const h = createHash('sha256')
    .update(JSON.stringify([systemOf(wire, b), user]))
    .digest('base64url');
  return `${client}h:${h}`;
}

/** 会话键 → 上次成功的 (供应商, Key)，内存 LRU */
export class Affinity {
  private readonly map = new Map<string, AffinityTarget & { at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly max = AFFINITY_MAX,
    private readonly ttlMs = AFFINITY_TTL_MS,
  ) {}

  get(session: string): AffinityTarget | null {
    const e = this.map.get(session);
    if (!e) return null;
    this.map.delete(session);
    if (this.now() - e.at > this.ttlMs) return null;
    this.map.set(session, e);
    return { providerId: e.providerId, keyId: e.keyId };
  }

  set(session: string, t: AffinityTarget): void {
    this.map.delete(session);
    this.map.set(session, { providerId: t.providerId, keyId: t.keyId, at: this.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  get size(): number {
    return this.map.size;
  }
}
