/**
 * 旧 Electron 对话导入（#181）。
 *
 * 2.0.4（Electron）的会话在 Chromium localStorage 里；Go 版首启把其中的 `ai-chat:*` 键抽到 userData，
 * 经契约 `migration.chatHistory` 交给对话窗口。这里在会话存储（ConversationStore）第一次构造之前取一次，
 * 幂等合并进本窗口的存储：
 * - 只补没有的：已有的会话（Go 版里新建 / 上次已导入的）一条不覆盖，当前会话指针也只在空着时才补；
 * - 按最近更新从新到旧一条一条导入：先写这条会话的消息，再把它加进索引，索引与已写的消息始终一致；
 *   存储满了（WebKit 的 localStorage 配额比 Chromium 小，聊天很多时放不下）就撤掉写不进的那条、停下，
 *   已导入的保留并记完成——只导入最新的一部分；一条都放不进才算失败，下次启动再试；
 * - 完成标记（`LEGACY_IMPORT_MARKER`，不以 `ai-chat:` 开头，免得被下一次抽取带上）只在导入成功 /
 *   确认没有可导入的之后才写；抽取失败、导入失败、内核不可用都不写，下次启动再试；
 * - 只读契约返回的副本，Electron 原数据不动。
 * Node 版（Electron）内核恒返回 `none`：第一次打开就记完成，之后不再询问。
 */

import { createLogger } from '@nomi-ai/ui';

import type { KeyValueStorage } from './conversationStore';

const log = createLogger('legacyChatImport');

export const LEGACY_IMPORT_MARKER = 'nomi:legacyChatImport';

const INDEX_KEY = 'ai-chat:conversations';
const CURRENT_KEY = 'ai-chat:currentConversation';
const LAST_NOMI_KEY = 'ai-chat:lastNomiConversation';
const MESSAGES_PREFIX = 'ai-chat:conversation:';

/** 契约 `migration.chatHistory` 的返回值（packages/contract/src/app/shell/schemas.ts） */
export interface LegacyChatHistory {
  status: 'none' | 'ready' | 'failed';
  entries: Record<string, string>;
  error?: string;
}

export type LegacyImportResult =
  /** 之前已完成，没有再问内核 */
  | { status: 'done-before' }
  /** 没有可导入的（已记完成） */
  | { status: 'none' }
  /** 导入完成（已记完成）；conversations = 新补进来的会话数，skipped = 存储放不下、没导入的较旧会话数 */
  | { status: 'imported'; conversations: number; skipped: number }
  /** 内核抽取失败（未记完成，下次再试） */
  | { status: 'extract-failed'; error: string }
  /** 写进本窗口存储失败（未记完成，已回滚，下次再试） */
  | { status: 'import-failed'; error: string }
  /** 问不到内核 / 超时（未记完成，下次再试） */
  | { status: 'unavailable'; error: string };

export interface LegacyImportOptions {
  fetch: () => Promise<LegacyChatHistory>;
  storage: KeyValueStorage;
  /** 等内核的上限：超时就先不导入（不挡对话窗口），晚到的结果丢弃。默认 10 秒 */
  timeoutMs?: number;
  now?: () => number;
}

interface MetaLike {
  id: string;
  [k: string]: unknown;
}

function parse(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function metaList(raw: string | null | undefined): MetaLike[] {
  const v = parse(raw);
  if (!Array.isArray(v)) return [];
  return v.filter(
    (c): c is MetaLike =>
      !!c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string',
  );
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function markDone(
  storage: KeyValueStorage,
  status: 'none' | 'imported',
  at: number,
  conversations = 0,
): void {
  try {
    storage.setItem(LEGACY_IMPORT_MARKER, JSON.stringify({ status, at, conversations }));
  } catch (e) {
    // 标记没写上：下次启动会再合并一次，已有的会话按 id 跳过，结果不变
    log.warn('legacy chat import marker not saved', e);
  }
}

/** 合并结果：added = 新补进来的会话数；skipped = 存储放不下、没导入的较旧会话数 */
export interface LegacyMergeResult {
  added: number;
  skipped: number;
}

/**
 * 把抽出的键幂等合并进 storage。按最近更新从新到旧逐条导入（消息 → 索引），存储写满就停下，较旧的会话不导入；
 * 一条都写不进时回滚并抛出（导入失败，下次再试）。
 */
export function mergeLegacyChatEntries(
  storage: KeyValueStorage,
  entries: Record<string, string>,
): LegacyMergeResult {
  const current = metaList(storage.getItem(INDEX_KEY));
  const have = new Set(current.map((c) => c.id));
  const seen = new Set<string>();
  const candidates = metaList(entries[INDEX_KEY]).filter((c) => {
    if (have.has(c.id) || seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  const updatedAt = (c: MetaLike) => (typeof c.updatedAt === 'number' ? c.updatedAt : 0);
  const newestFirst = [...candidates].sort((a, b) => updatedAt(b) - updatedAt(a));

  // 1) 逐条：这条会话的消息 → 带上它的索引。写不进就撤掉这条的消息并停下（索引仍是上一条成功后的样子）
  const added: MetaLike[] = [];
  let lastError: unknown;
  for (const meta of newestFirst) {
    const key = MESSAGES_PREFIX + meta.id;
    const raw = entries[key];
    try {
      // 不在索引里的消息键只可能是上次失败留下的残片（或旧数据里的孤儿），直接覆盖
      storage.setItem(key, raw !== undefined && Array.isArray(parse(raw)) ? raw : '[]');
      storage.setItem(INDEX_KEY, JSON.stringify([...current, ...added, meta]));
      added.push(meta);
    } catch (e) {
      lastError = e;
      try {
        storage.removeItem(key);
      } catch {
        /* */
      }
      break;
    }
  }
  if (candidates.length > 0 && added.length === 0) throw lastError;
  const skipped = candidates.length - added.length;
  // 2) 索引按旧数据原来的顺序排好（上面是从新到旧逐条追加的）；同样大小，写不进就保留逐条写的那份
  if (added.length > 1) {
    const ok = new Set(added.map((c) => c.id));
    trySet(
      storage,
      INDEX_KEY,
      JSON.stringify([...current, ...candidates.filter((c) => ok.has(c.id))]),
    );
  }
  if (skipped > 0)
    log.warn('legacy chat import: storage full, older conversations not imported', skipped);

  // 3) 会话指针：只在空着 / 指向已不存在的会话时补上旧的
  const ids = new Set([...current, ...added].map((c) => c.id));
  for (const key of [CURRENT_KEY, LAST_NOMI_KEY]) {
    const old = parse(entries[key]);
    if (typeof old !== 'string' || !ids.has(old)) continue;
    const mine = parse(storage.getItem(key));
    if (typeof mine === 'string' && ids.has(mine)) continue;
    trySet(storage, key, entries[key]!);
  }

  // 4) 其余 ai-chat:* 偏好（对话设置、侧栏视图等）：本窗口没有的才补
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith('ai-chat:') || key === INDEX_KEY || key === CURRENT_KEY) continue;
    if (key === LAST_NOMI_KEY || key.startsWith(MESSAGES_PREFIX)) continue;
    if (storage.getItem(key) !== null) continue;
    trySet(storage, key, value);
  }
  return { added: added.length, skipped };
}

function trySet(storage: KeyValueStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch (e) {
    log.warn('legacy chat import: skipped key', key, e);
  }
}

export async function importLegacyChatHistory(
  opts: LegacyImportOptions,
): Promise<LegacyImportResult> {
  const { storage } = opts;
  const now = opts.now ?? Date.now;
  try {
    if (storage.getItem(LEGACY_IMPORT_MARKER) !== null) return { status: 'done-before' };
  } catch {
    /* 读不了存储：照常问一次 */
  }

  let res: LegacyChatHistory;
  try {
    res = await withTimeout(opts.fetch(), opts.timeoutMs ?? 10_000);
  } catch (e) {
    return { status: 'unavailable', error: errText(e) };
  }

  if (res.status === 'failed') {
    return { status: 'extract-failed', error: res.error ?? 'unknown error' };
  }
  if (res.status !== 'ready' || Object.keys(res.entries ?? {}).length === 0) {
    markDone(storage, 'none', now());
    return { status: 'none' };
  }

  let merged: LegacyMergeResult;
  try {
    merged = mergeLegacyChatEntries(storage, res.entries);
  } catch (e) {
    return { status: 'import-failed', error: errText(e) };
  }
  markDone(storage, 'imported', now(), merged.added);
  return { status: 'imported', conversations: merged.added, skipped: merged.skipped };
}

/** 入口用：结果写日志；失败只记日志（不挡对话窗口），下次启动再试 */
export async function runLegacyChatImport(opts: LegacyImportOptions): Promise<LegacyImportResult> {
  const result = await importLegacyChatHistory(opts);
  switch (result.status) {
    case 'imported':
      log.info('legacy chat history imported', result.conversations, 'skipped', result.skipped);
      break;
    case 'extract-failed':
    case 'import-failed':
    case 'unavailable':
      log.warn(`legacy chat history ${result.status}, will retry next launch`, result.error);
      break;
    default:
      break;
  }
  return result;
}
