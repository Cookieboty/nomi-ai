/**
 * 一次性迁移：对话窗口旧的 localStorage 会话 → Go 内核的会话存储（契约 `conversations.*`）。
 *
 * 旧布局（2.2.0 及以前）：
 *   ai-chat:conversations          元信息列表
 *   ai-chat:conversation:<id>      该会话的 ChatMessage[]
 *   ai-chat:currentConversation    当前会话 id；ai-chat:lastNomiConversation 最近的 Nomi 会话
 *   ai-chat:conversationPreviews   { id: 第一条用户消息预览 }
 *   ai-chat:history                更早的单会话历史
 *
 * - 导入索引里的每个会话；索引里没有、但消息键还在的（以前存储满了索引没写进去）也导入，元信息按消息补；
 *   消息不是数组的按空会话导入；id 不能当文件名的（含 Windows 保留名，规则同内核）换一个固定的新 id
 *   （`remapConversationId`，同一个旧 id 每次换出来的一样）导入，旧 id 记在元信息的 `legacyId`；
 * - 幂等：内核里已有的 id 不覆盖（内核侧保证）；大会话分几次发，中途中断的内核不收进索引，下次从头再导；
 *   几个会话同时导（每个会话的几块按顺序），进度经 `onProgress` 报给启动画面；
 * - 导完重新取一次索引核对：来源里的会话（含换了 id 的）都在了才记完成（`conversations.markMigrated`），
 *   否则下次启动再试；
 * - 旧键保留一个版本（降级回旧版还能看到），不在这里删。
 */

import { createLogger, t } from '@nomi-ai/ui';

import type { ChatMessage } from '../types/chat';
import { isConversationBackend } from '../types/chat';

import {
  isValidConversationId,
  type ConversationKernel,
  type ConversationMeta,
  type ConversationSnapshot,
} from './conversationKernel';
import { previewOf } from './conversationStore';

const log = createLogger('conversationMigration');

export const LEGACY_KEYS = {
  index: 'ai-chat:conversations',
  current: 'ai-chat:currentConversation',
  lastNomi: 'ai-chat:lastNomiConversation',
  previews: 'ai-chat:conversationPreviews',
  history: 'ai-chat:history',
  messagesPrefix: 'ai-chat:conversation:',
} as const;

/** 旧的单会话历史导入成这个 id（固定 id，重复导入按 id 跳过） */
export const LEGACY_HISTORY_ID = 'legacy_history';

/** 会话相关的旧键（不含其余 ai-chat:* 偏好） */
export function isLegacyConversationKey(key: string): boolean {
  return (
    key === LEGACY_KEYS.index ||
    key === LEGACY_KEYS.current ||
    key === LEGACY_KEYS.lastNomi ||
    key === LEGACY_KEYS.previews ||
    key === LEGACY_KEYS.history ||
    key.startsWith(LEGACY_KEYS.messagesPrefix)
  );
}

export interface EnumerableStorage {
  readonly length: number;
  key(i: number): string | null;
  getItem(key: string): string | null;
}

interface LegacyConversation {
  meta: ConversationMeta;
  messages: ChatMessage[];
  preview: string;
}

function parse(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function messagesOf(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is ChatMessage => !!m && typeof m === 'object' && !Array.isArray(m));
}

function keysOf(storage: EnumerableStorage): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k) out.push(k);
    }
  } catch {
    /* 读不了存储：当作没有 */
  }
  return out;
}

function read(storage: EnumerableStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** 按消息补一份元信息（索引里没有的会话） */
function synthesizeMeta(id: string, messages: ChatMessage[], name: string): ConversationMeta {
  const ts = messages.map((m) => m.timestamp).filter((x) => typeof x === 'number');
  const first = ts.length ? Math.min(...ts) : 0;
  const last = ts.length ? Math.max(...ts) : 0;
  const user = previewOf(messages).replace(/\s+/g, ' ').trim().slice(0, 30);
  return { id, name: user || name, createdAt: first, updatedAt: last, backend: 'nomi' };
}

/** FNV-1a 32 位（换 id 用：同一个旧 id 每次得到同一个新 id，重复导入按 id 跳过） */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 不能当文件名的旧 id → 合法的新 id：`m_<旧 id 的散列>_<旧 id 里能用的字符>`（固定、不会是保留名）
 */
export function remapConversationId(id: string): string {
  const safe = id
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `m_${fnv1a(id)}${safe ? `_${safe}` : ''}`;
}

/** 从旧存储里读出所有会话（remapped = id 不能当文件名、换了新 id 的：旧 id → 新 id） */
export function readLegacyConversations(storage: EnumerableStorage): {
  conversations: LegacyConversation[];
  current?: string;
  lastNomi?: string;
  remapped: Array<{ from: string; to: string }>;
} {
  const previewsRaw = parse(read(storage, LEGACY_KEYS.previews));
  const previews =
    previewsRaw && typeof previewsRaw === 'object' && !Array.isArray(previewsRaw)
      ? (previewsRaw as Record<string, unknown>)
      : {};
  const out: LegacyConversation[] = [];
  const remapped: Array<{ from: string; to: string }> = [];
  /** 旧 id → 导入用的 id */
  const ids = new Map<string, string>();
  const used = new Set<string>();
  const add = (meta: ConversationMeta, messages: ChatMessage[]) => {
    if (ids.has(meta.id)) return;
    const to = isValidConversationId(meta.id) ? meta.id : remapConversationId(meta.id);
    if (used.has(to)) return;
    ids.set(meta.id, to);
    used.add(to);
    const known = previews[meta.id];
    const base = isConversationBackend(meta.backend) ? meta : { ...meta, backend: 'nomi' as const };
    if (to !== meta.id) remapped.push({ from: meta.id, to });
    out.push({
      meta: to === meta.id ? base : { ...base, id: to, legacyId: meta.id },
      messages,
      preview: typeof known === 'string' ? known : previewOf(messages),
    });
  };
  const index = parse(read(storage, LEGACY_KEYS.index));
  if (Array.isArray(index)) {
    for (const c of index) {
      if (!c || typeof c !== 'object' || typeof (c as { id?: unknown }).id !== 'string') continue;
      const meta = c as ConversationMeta;
      add(meta, messagesOf(parse(read(storage, LEGACY_KEYS.messagesPrefix + meta.id))));
    }
  }
  // 索引里没有的消息键：以前存储满了、索引没写进去的会话
  for (const key of keysOf(storage)) {
    if (!key.startsWith(LEGACY_KEYS.messagesPrefix)) continue;
    const id = key.slice(LEGACY_KEYS.messagesPrefix.length);
    if (ids.has(id)) continue;
    const messages = messagesOf(parse(read(storage, key)));
    if (!messages.length) continue;
    add(synthesizeMeta(id, messages, t('ui.chat-settings.history')), messages);
  }
  // 更早的单会话历史
  const history = messagesOf(parse(read(storage, LEGACY_KEYS.history)));
  if (history.length && !ids.has(LEGACY_HISTORY_ID))
    add(synthesizeMeta(LEGACY_HISTORY_ID, history, t('ui.chat-settings.history')), history);
  const ptr = (key: string) => {
    const v = parse(read(storage, key));
    return typeof v === 'string' ? ids.get(v) : undefined;
  };
  const current = ptr(LEGACY_KEYS.current);
  const lastNomi = ptr(LEGACY_KEYS.lastNomi);
  return {
    conversations: out,
    ...(current ? { current } : {}),
    ...(lastNomi ? { lastNomi } : {}),
    remapped,
  };
}

/** 按 JSON 大小切块（每次调用远小于契约连接的 16 MB 帧上限） */
function chunks(messages: ChatMessage[], maxChars: number): ChatMessage[][] {
  const out: ChatMessage[][] = [];
  let cur: ChatMessage[] = [];
  let size = 0;
  for (const m of messages) {
    let n: number;
    try {
      n = JSON.stringify(m).length;
    } catch {
      continue; // 序列化不了的消息本来也存不进去
    }
    if (cur.length && size + n > maxChars) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(m);
    size += n;
  }
  out.push(cur);
  return out;
}

export interface MigrationResult {
  /** complete：来源里的会话都在内核里了（mark 时已记完成）；incomplete：有没导进去的，下次再试 */
  status: 'complete' | 'incomplete';
  /** 来源里的会话数（含换了 id 的） */
  total: number;
  /** 这次新导入的 */
  imported: number;
  /** id 不能当文件名、换了新 id 导入的 */
  remapped: number;
  /** 导入后的索引（失败时是导入前的） */
  snapshot: ConversationSnapshot;
}

export interface MigrationProgress {
  /** 已处理的会话（导入了 / 已经在内核里 / 失败了） */
  done: number;
  total: number;
}

export async function migrateConversationsToKernel(opts: {
  kernel: ConversationKernel;
  source: EnumerableStorage;
  snapshot: ConversationSnapshot;
  /** 核对完成后记 `markMigrated`（首次迁移）；补导 Electron 旧会话时不记 */
  mark: boolean;
  /** 每次调用最多带这么多字符的消息，默认 4M */
  maxChunkChars?: number;
  /** 同时导入的会话数，默认 4（内核按会话串行写，这里省的是往返等待） */
  concurrency?: number;
  onProgress?: (p: MigrationProgress) => void;
}): Promise<MigrationResult> {
  const { kernel } = opts;
  const legacy = readLegacyConversations(opts.source);
  if (legacy.remapped.length)
    log.warn('conversation migration: remapped ids that cannot be file names', legacy.remapped);
  const have = new Set(opts.snapshot.conversations.map((c) => c.id));
  const todo = legacy.conversations.filter((c) => !have.has(c.meta.id));
  const total = legacy.conversations.length;
  let done = total - todo.length;
  let imported = 0;
  let failed = 0;
  opts.onProgress?.({ done, total });
  const importOne = async (conv: LegacyConversation) => {
    try {
      const parts = chunks(conv.messages, opts.maxChunkChars ?? 4_000_000);
      for (let i = 0; i < parts.length; i++) {
        const r = await kernel.importConversation({
          meta: conv.meta,
          messages: parts[i]!,
          preview: conv.preview,
          first: i === 0,
          final: i === parts.length - 1,
        });
        if (r.imported) imported++;
      }
    } catch (e) {
      failed++;
      log.warn('conversation migration: import failed', {
        id: conv.meta.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    done++;
    opts.onProgress?.({ done, total });
  };
  let next = 0;
  const worker = async () => {
    while (next < todo.length) await importOne(todo[next++]!);
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, todo.length)) }, worker),
  );
  const base = { total, imported, remapped: legacy.remapped.length };
  let snapshot = opts.snapshot;
  try {
    snapshot = await kernel.state();
  } catch (e) {
    log.warn('conversation migration: state unavailable after import', e);
    return { status: 'incomplete', ...base, snapshot };
  }
  const ids = new Set(snapshot.conversations.map((c) => c.id));
  const missing = legacy.conversations.filter((c) => !ids.has(c.meta.id)).length;
  if (missing > 0 || failed > 0) {
    log.warn('conversation migration incomplete, will retry next launch', { missing, failed });
    return { status: 'incomplete', ...base, snapshot };
  }
  // 当前会话 / 最近的 Nomi 会话：内核里还空着（或指向不存在的）才用旧的
  const pointers: { current?: string; lastNomi?: string } = {};
  if (legacy.current && !(snapshot.current && ids.has(snapshot.current)))
    pointers.current = legacy.current;
  if (legacy.lastNomi && !(snapshot.lastNomi && ids.has(snapshot.lastNomi)))
    pointers.lastNomi = legacy.lastNomi;
  try {
    if (pointers.current || pointers.lastNomi) await kernel.setPointers(pointers);
    if (opts.mark) await kernel.markMigrated(legacy.conversations.length);
    snapshot = await kernel.state();
  } catch (e) {
    log.warn('conversation migration: could not record completion', e);
    return { status: 'incomplete', ...base, snapshot };
  }
  if (imported) log.info('conversations migrated to the kernel', base);
  return { status: 'complete', ...base, snapshot };
}
