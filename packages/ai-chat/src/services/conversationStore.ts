/**
 * ConversationStore —— 按会话持久化聊天记录（渲染进程 localStorage）。
 *
 * 存储布局：
 *   ai-chat:conversations          → ChatSession 元信息列表（不含 messages）
 *   ai-chat:conversation:<id>      → 该会话的 ChatMessage[]
 *   ai-chat:currentConversation    → 当前会话 id
 *   ai-chat:conversationPreviews   → { [id]: 第一条用户消息的前 300 字 }（侧栏搜索用，缺了按需从消息补）
 * 旧版单会话 `ai-chat:history` 在首次访问时迁移为一个会话。
 * 无 backend 字段的旧行迁移为 nomi。
 * 无 localStorage（测试 / 非浏览器）时退化为内存存储。
 */

import { createLogger, t } from '@nomi-ai/ui';

import type { ChatMessage, ChatSession, ConversationBackend } from '../types/chat';
import { isConversationBackend } from '../types/chat';

import { splitFileAttachments } from './fileAttachments';
import { clearNomiAutoTitle, isDefaultChatName } from './sessionTitle';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ConversationMeta = Omit<ChatSession, 'messages'>;

const INDEX_KEY = 'ai-chat:conversations';
const CURRENT_KEY = 'ai-chat:currentConversation';
/** 最近一次作为「当前」的 Nomi 会话：当前导航在 CLI 镜像上时，回到 Nomi 主标签要恢复它（#19） */
const LAST_NOMI_KEY = 'ai-chat:lastNomiConversation';
const LEGACY_HISTORY_KEY = 'ai-chat:history';
/** 第一条用户消息预览：侧栏搜索不用为每个会话解析整段历史 */
const PREVIEW_KEY = 'ai-chat:conversationPreviews';
const PREVIEW_LEN = 300;
const MESSAGES_PREFIX = 'ai-chat:conversation:';
const messagesKey = (id: string) => `${MESSAGES_PREFIX}${id}`;
/** 合并写最多等这么久（空闲回调的 timeout / 没有 requestIdleCallback 时的延时） */
const FLUSH_TIMEOUT_MS = 1000;
const FLUSH_FALLBACK_DELAY_MS = 250;
/** 存储满了之后，同一会话在这段时间内不再重试（不用每轮都白白序列化整段历史）；删会话会立刻解除 */
const QUOTA_BACKOFF_MS = 60_000;

const log = createLogger('conversationStore');

function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const { name, code } = e as { name?: unknown; code?: unknown };
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

export function createMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function defaultStorage(): KeyValueStorage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* localStorage 可能被禁用 */
  }
  return createMemoryStorage();
}

export interface ConversationStoreOptions {
  storage?: KeyValueStorage;
  /** 每个会话最多保留的消息条数（超出丢弃最旧的），默认 1000 */
  maxMessages?: number;
  /**
   * 同时留在内存里的会话份数（LRU）。当前会话不会被淘汰。默认 12。
   */
  maxCachedConversations?: number;
  /**
   * 内存里消息缓存的总字符预算（按 JSON 长度计），默认 8M 字符：普通长度的会话能留住 8–12 段，
   * 少数巨型会话也不会把堆撑爆。当前会话不会被淘汰。
   */
  maxCachedChars?: number;
  now?: () => number;
  newId?: () => string;
  /**
   * 追加消息时合并写盘：内存立即更新，序列化与 setItem 放到空闲时做（同一会话多次写只做一次）。
   * 读同一会话、切换会话、页面隐藏 / 关闭、dispose 前都会先写盘。默认 true；false = 每次立即写（旧行为）。
   */
  deferWrites?: boolean;
}

export interface CreateConversationOpts {
  name?: string;
  backend?: ConversationBackend;
  tabId?: string;
  /** Nomi 对话的工作区（见 ChatSession.cwd） */
  cwd?: string;
  /** 创建后是否设为当前会话，默认 true */
  activate?: boolean;
}

export interface ForkConversationOpts {
  /** 目标后端；默认与源相同 */
  backend?: ConversationBackend;
  tabId?: string;
  name?: string;
  /** 工作区；默认沿用源会话的（只对 Nomi 对话有意义） */
  cwd?: string;
  /** 覆盖要复制的消息；默认复制源会话全部消息 */
  messages?: ChatMessage[];
}

/** 会话列表被外部改动（分叉等）后在 window 上广播，侧栏据此立即刷新 */
export const CONVERSATIONS_CHANGED_EVENT = 'nomi:conversations-changed';

export type ConversationsChangedDetail = {
  /** 删除路径带上被删项，App 可直接 drop 私有草稿（不依赖 prev 快照） */
  removed?: Array<{ id: string; tabId?: string }>;
};

export function notifyConversationsChanged(detail?: ConversationsChangedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CONVERSATIONS_CHANGED_EVENT, { detail }));
}

export class ConversationStore {
  private readonly storage: KeyValueStorage;
  private readonly now: () => number;
  private readonly newId: () => string;
  /** 避免每次切换会话都在渲染线程重复 JSON.parse 整段历史。超出上限按 LRU 丢掉。 */
  private readonly messagesCache = new Map<string, ChatMessage[]>();
  /** JSON length of each cached conversation (for the char budget) */
  private readonly cacheChars = new Map<string, number>();
  private cachedChars = 0;
  maxMessages: number;
  private readonly maxCachedConversations: number;
  private readonly maxCachedChars: number;
  /**
   * In-memory mirror of the index / current / last-Nomi keys: list() and friends used to
   * JSON.parse the whole index from storage on every call (13 call sites, several per op).
   * This store is the only writer in this window; other windows' writes arrive as `storage`
   * events and invalidate the mirror.
   */
  private index: ConversationMeta[] | undefined;
  private current: { v: string | undefined } | undefined;
  private lastNomi: { v: string | undefined } | undefined;
  private readonly offStorage: () => void;
  private readonly offLifecycle: () => void;
  private readonly deferWrites: boolean;
  /** 待写盘的消息（key → 最新的整份消息）；读同一 key 前先写盘 */
  private readonly pending = new Map<string, ChatMessage[]>();
  private cancelFlush: (() => void) | undefined;
  /** 存储满了写不进的 key → 失败时间；退避期内跳过（关窗前的最后一次写仍会试） */
  private readonly quotaFailed = new Map<string, number>();
  /** 第一条用户消息预览（PREVIEW_KEY 的内存副本，懒加载）；变了就标脏，随合并写一起写盘 */
  private previews: Record<string, string> | undefined;
  private previewsDirty = false;
  /** 新 Nomi 对话没指定工作区时用的目录（IPCClient 注入主标签当前的目录；缺省没有） */
  defaultNomiCwd: () => string | undefined = () => undefined;

  constructor(opts: ConversationStoreOptions = {}) {
    this.storage = opts.storage ?? defaultStorage();
    this.maxMessages = opts.maxMessages ?? 1000;
    this.maxCachedConversations = Math.max(1, opts.maxCachedConversations ?? 12);
    this.maxCachedChars = Math.max(0, opts.maxCachedChars ?? 8_000_000);
    this.offStorage = this.listenForeignWrites();
    this.deferWrites = opts.deferWrites ?? true;
    this.offLifecycle = this.deferWrites ? this.listenLifecycle() : () => undefined;
    this.now = opts.now ?? Date.now;
    this.newId =
      opts.newId ??
      (() => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    this.migrateLegacy();
    this.migrateBackends();
  }

  list(): ConversationMeta[] {
    return [...this.idx()];
  }

  /** Stop listening for other windows' writes (pending writes are flushed first). */
  dispose(): void {
    this.flush({ force: true });
    this.offStorage();
    this.offLifecycle();
  }

  /** 把合并中的消息写盘。force：忽略存储满了的退避（页面关闭前的最后机会）。 */
  flush(opts: { force?: boolean } = {}): void {
    this.cancelFlush?.();
    this.cancelFlush = undefined;
    for (const key of [...this.pending.keys()]) this.flushKey(key, opts.force);
    if (this.previewsDirty && this.previews) {
      this.previewsDirty = false;
      this.write(PREVIEW_KEY, this.previews);
    }
  }

  private previewMap(): Record<string, string> {
    if (!this.previews) {
      const raw = this.read<unknown>(PREVIEW_KEY);
      this.previews =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, string>)
          : {};
    }
    return this.previews;
  }

  /** 消息变了之后更新这个会话的预览（通常只看第一条，不序列化） */
  private updatePreview(id: string, messages: readonly ChatMessage[]): void {
    const map = this.previewMap();
    const next = previewOf(messages);
    if (map[id] === next) return;
    map[id] = next;
    this.previewsDirty = true;
    if (this.deferWrites) this.scheduleFlush();
    else this.flush();
  }

  private dropPreview(id: string): void {
    const map = this.previewMap();
    if (!(id in map)) return;
    delete map[id];
    this.previewsDirty = true;
    if (this.deferWrites) this.scheduleFlush();
    else this.flush();
  }

  private flushKey(key: string, force = false): void {
    const value = this.pending.get(key);
    if (!value) return;
    const failedAt = this.quotaFailed.get(key);
    // 存储满了：退避期内不序列化，留着等下次（页面关闭前 force 再试一次）
    if (!force && failedAt !== undefined && this.now() - failedAt < QUOTA_BACKOFF_MS) return;
    this.pending.delete(key);
    const chars = this.write(key, value);
    // 缓存里还是这一份：用真实长度替换估算值（字符预算）
    const id = key.slice(MESSAGES_PREFIX.length);
    if (chars && this.messagesCache.get(id) === value) this.setChars(id, chars);
  }

  private scheduleFlush(): void {
    if (this.cancelFlush) return;
    const run = () => {
      this.cancelFlush = undefined;
      this.flush();
    };
    const g = globalThis as typeof globalThis & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    if (typeof g.requestIdleCallback === 'function') {
      const h = g.requestIdleCallback(run, { timeout: FLUSH_TIMEOUT_MS });
      this.cancelFlush = () => g.cancelIdleCallback?.(h);
    } else {
      const h = setTimeout(run, FLUSH_FALLBACK_DELAY_MS);
      this.cancelFlush = () => clearTimeout(h);
    }
  }

  /** 页面隐藏 / 关闭时把合并中的消息写盘 */
  private listenLifecycle(): () => void {
    if (typeof window === 'undefined' || !window.addEventListener) return () => undefined;
    const now = () => this.flush({ force: true });
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') now();
    };
    window.addEventListener('pagehide', now);
    window.addEventListener('beforeunload', now);
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', now);
      window.removeEventListener('beforeunload', now);
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  /** 消息写盘：合并模式下只记下，空闲时写；否则立即写。返回缓存字符预算用的长度（估算或真实）。 */
  private writeMessages(id: string, messages: ChatMessage[], estimate: number): number {
    const key = messagesKey(id);
    if (!this.deferWrites) return this.write(key, messages);
    this.pending.set(key, messages);
    this.scheduleFlush();
    return estimate;
  }

  /** 立即写一份消息（取代合并中的那份） */
  private writeMessagesNow(id: string, messages: ChatMessage[]): number {
    this.pending.delete(messagesKey(id));
    return this.write(messagesKey(id), messages);
  }

  /** Drop the in-memory mirror (another window wrote the same storage). */
  invalidate(key?: string | null): void {
    if (!key || key === INDEX_KEY) this.index = undefined;
    if (!key || key === CURRENT_KEY) this.current = undefined;
    if (!key || key === LAST_NOMI_KEY) this.lastNomi = undefined;
    if (!key || key === PREVIEW_KEY) {
      this.previews = undefined;
      this.previewsDirty = false;
    }
    if (!key) {
      this.messagesCache.clear();
      this.cacheChars.clear();
      this.cachedChars = 0;
    } else if (key.startsWith(MESSAGES_PREFIX)) {
      const id = key.slice(MESSAGES_PREFIX.length);
      this.forget(id);
      // 别的窗口改了这段消息：预览下次搜索时按需重算
      if (this.previews && id in this.previews) delete this.previews[id];
    }
  }

  private listenForeignWrites(): () => void {
    if (typeof window === 'undefined' || !window.addEventListener) return () => undefined;
    let isLocal = false;
    try {
      isLocal = this.storage === window.localStorage;
    } catch {
      /* */
    }
    if (!isLocal) return () => undefined;
    const on = (e: StorageEvent) => this.invalidate(e.key);
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }

  private idx(): ConversationMeta[] {
    if (!this.index) this.index = this.read<ConversationMeta[]>(INDEX_KEY) ?? [];
    return this.index;
  }

  private writeIndex(list: ConversationMeta[]): void {
    this.index = list;
    this.write(INDEX_KEY, list);
  }

  private readCurrent(): string | undefined {
    if (!this.current) this.current = { v: this.read<string>(CURRENT_KEY) };
    return this.current.v;
  }

  private writeCurrent(id: string | undefined): void {
    this.current = { v: id };
    if (id === undefined) this.storage.removeItem(CURRENT_KEY);
    else this.write(CURRENT_KEY, id);
  }

  private readLastNomi(): string | undefined {
    if (!this.lastNomi) this.lastNomi = { v: this.read<string>(LAST_NOMI_KEY) };
    return this.lastNomi.v;
  }

  /** Only writes when it changes. */
  private writeLastNomi(id: string): void {
    if (this.readLastNomi() === id) return;
    this.lastNomi = { v: id };
    this.write(LAST_NOMI_KEY, id);
  }

  listByBackend(backend: ConversationBackend): ConversationMeta[] {
    return this.idx().filter((c) => c.backend === backend);
  }

  /** 当前会话 id；不存在时返回 undefined（不隐式创建） */
  currentId(): string | undefined {
    const id = this.readCurrent();
    if (id && this.idx().some((c) => c.id === id)) return id;
    return undefined;
  }

  /** 取当前会话 id，没有则新建一个 Nomi 会话 */
  ensureCurrent(): string {
    return this.currentId() ?? this.create().id;
  }

  /** 是 Nomi 自己的会话（不是 CLI 标签的镜像项）：只有这类会话能承载 Nomi 的对话轮次 */
  isNomi(id: string | undefined): boolean {
    const meta = id ? this.get(id) : undefined;
    return !!meta && meta.backend === 'nomi' && !meta.tabId;
  }

  /**
   * 最近使用的 Nomi 会话：优先记录的「最后一个 Nomi 当前会话」；
   * 记录失效（被删）时退回最近更新的 Nomi 会话；一个都没有则 undefined。
   */
  lastNomiId(): string | undefined {
    const rec = this.readLastNomi();
    if (rec && this.isNomi(rec)) return rec;
    return this.idx()
      .filter((c) => c.backend === 'nomi' && !c.tabId)
      .reduce<ConversationMeta | undefined>(
        (acc, c) => (!acc || c.updatedAt > acc.updatedAt ? c : acc),
        undefined,
      )?.id;
  }

  /**
   * Nomi 轮次专用：保证返回的是 Nomi 会话。当前导航若停在 CLI 镜像 / 为空，
   * 先恢复最近的 Nomi 会话，没有才新建；绝不返回 CLI 镜像 id。
   */
  ensureCurrentNomi(): string {
    const cur = this.currentId();
    if (cur && this.isNomi(cur)) return cur;
    const last = this.lastNomiId();
    if (last) {
      this.switchTo(last);
      return last;
    }
    return this.create().id;
  }

  /**
   * Nomi 轮次写入目标，但**不改变导航**（#19）：当前停在 CLI 镜像（用户正看着 CLI 标签）时，
   * 写进最近的 Nomi 会话，没有就静默新建一个（不激活），侧栏高亮不会跳走。
   * 导航为空（没有任何可打扰的界面）时与 ensureCurrentNomi 相同。
   */
  nomiTarget(): string {
    const cur = this.currentId();
    if (cur && this.isNomi(cur)) return cur;
    if (!cur) return this.ensureCurrentNomi();
    return this.lastNomiId() ?? this.create({ activate: false }).id;
  }

  get(id: string): ConversationMeta | undefined {
    return this.idx().find((c) => c.id === id);
  }

  findByTabId(tabId: string): ConversationMeta | undefined {
    return this.idx().find((c) => c.tabId === tabId);
  }

  findByCliSessionId(
    backend: ConversationBackend,
    cliSessionId: string,
  ): ConversationMeta | undefined {
    return this.idx().find((c) => c.backend === backend && c.cliSessionId === cliSessionId);
  }

  create(nameOrOpts?: string | CreateConversationOpts): ConversationMeta {
    const opts: CreateConversationOpts =
      typeof nameOrOpts === 'string' || nameOrOpts === undefined
        ? { name: nameOrOpts }
        : nameOrOpts;
    const ts = this.now();
    const meta: ConversationMeta = {
      id: this.newId(),
      name: opts.name ?? t('ui.chat-settings.new-chat'),
      createdAt: ts,
      updatedAt: ts,
      backend: opts.backend ?? 'nomi',
      ...(opts.tabId ? { tabId: opts.tabId } : {}),
    };
    const backend = meta.backend;
    const cwd = opts.cwd ?? (backend === 'nomi' && !opts.tabId ? this.defaultNomiCwd() : undefined);
    if (cwd) meta.cwd = cwd;
    this.writeIndex([...this.idx(), meta]);
    this.writeMessagesNow(meta.id, []);
    // 先记下当前会话，再放入缓存，这样淘汰时不会把刚建的会话丢掉
    if (opts.activate !== false) {
      this.writeCurrent(meta.id);
      if (meta.backend === 'nomi' && !meta.tabId) this.writeLastNomi(meta.id);
    }
    this.remember(meta.id, [], 2);
    return meta;
  }

  /** One index lookup; the last-Nomi key is written only when it changes. */
  switchTo(id: string): void {
    const meta = this.get(id);
    if (!meta) throw new Error(`unknown conversation: ${id}`);
    // 切会话：先把合并中的消息写盘
    if (this.pending.size) this.flush();
    if (this.readCurrent() !== id) this.writeCurrent(id);
    if (meta.backend === 'nomi' && !meta.tabId) this.writeLastNomi(id);
  }

  getMessages(id: string | undefined = this.currentId()): ChatMessage[] {
    if (!id) return [];
    const cached = this.messagesCache.get(id);
    if (cached) return this.touchCache(id, cached);
    const raw = this.readRaw(messagesKey(id));
    // 存储满了还没写进去的：内存里那份才是最新的
    const unsaved = this.pending.get(messagesKey(id));
    if (unsaved) {
      this.remember(id, unsaved, raw?.length ?? 2);
      return unsaved;
    }
    const messages = (raw ? this.parse<ChatMessage[]>(raw) : undefined) ?? [];
    this.remember(id, messages, raw?.length ?? 2);
    return messages;
  }

  /**
   * 侧栏搜索用：只要第一条用户消息的前若干字。
   * 命中缓存时直接读；未命中则解析后立刻丢掉，不进入 messagesCache。
   */
  firstUserPreview(id: string, maxLen = PREVIEW_LEN): string {
    const fits = maxLen <= PREVIEW_LEN;
    const map = this.previewMap();
    const known = fits && Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
    if (known !== undefined) return known.slice(0, maxLen);
    const cached = this.messagesCache.get(id);
    const messages =
      cached ?? this.pending.get(messagesKey(id)) ?? this.read<ChatMessage[]>(messagesKey(id));
    // 旧会话还没有预览：算一次记下来（之后搜索不再解析这段历史）
    if (fits && this.get(id)) {
      const preview = previewOf(messages ?? []);
      map[id] = preview;
      this.previewsDirty = true;
      if (this.deferWrites) this.scheduleFlush();
      else this.flush();
      return preview.slice(0, maxLen);
    }
    const text = messages?.find((m) => m.role === 'user')?.content ?? '';
    return splitFileAttachments(text).text.slice(0, maxLen);
  }

  setMessages(id: string, messages: ChatMessage[]): void {
    const next = messages.slice(-this.maxMessages);
    // 整体替换很少见（编辑重发）：立即写，长度也准
    this.remember(id, next, this.writeMessagesNow(id, next));
    this.updatePreview(id, next);
    this.touch(id);
  }

  append(message: ChatMessage, id: string | undefined = this.currentId()): void {
    if (!id) return;
    const prev = this.getMessages(id);
    const next = [...prev, message].slice(-this.maxMessages);
    const estimate = (this.cacheChars.get(id) ?? 2) + approxJsonLength(message) + 1;
    this.remember(id, next, this.writeMessages(id, next, estimate));
    this.updatePreview(id, next);
    this.touch(id, message);
  }

  /** 清空会话消息（会话本身保留） */
  clear(id: string | undefined = this.currentId()): void {
    if (!id) return;
    this.remember(id, [], this.writeMessagesNow(id, []));
    this.updatePreview(id, []);
    this.touch(id);
  }

  updateMeta(
    id: string,
    patch: Partial<Omit<ConversationMeta, 'id' | 'createdAt'>>,
  ): ConversationMeta {
    let updated: ConversationMeta | undefined;
    this.writeIndex(
      this.idx().map((c) => {
        if (c.id !== id) return c;
        updated = {
          ...c,
          ...patch,
          id: c.id,
          createdAt: c.createdAt,
          updatedAt: patch.updatedAt ?? this.now(),
        };
        return updated;
      }),
    );
    if (!updated) throw new Error(`unknown conversation: ${id}`);
    return updated;
  }

  /**
   * 同步 CLI 标签到侧栏元信息：已有则更新标题 / 时间 / 后端 / 原生会话 id；没有则新建。
   * 返回会话元信息。
   */
  upsertFromTab(tab: {
    id: string;
    title: string;
    backend: ConversationBackend;
    createdAt: number;
    updatedAt: number;
    cliSessionId?: string;
  }): ConversationMeta {
    if (tab.backend === 'nomi') {
      throw new Error('CLI tab sync requires a non-nomi backend');
    }
    // tab id 是当前窗口里的标签身份；CLI session id 是本机历史的稳定身份。
    // 优先按标签更新，标签被重建但仍绑定同一 CLI 会话时再按 session id 接回原镜像。
    const existing =
      this.findByTabId(tab.id) ??
      (tab.cliSessionId ? this.findByCliSessionId(tab.backend, tab.cliSessionId) : undefined);
    if (existing) {
      return this.updateMeta(existing.id, {
        name: tab.title,
        backend: tab.backend,
        tabId: tab.id,
        cliSessionId: tab.cliSessionId,
        // 重命名标签不一定会改 tab.updatedAt，镜像时间不能因此倒退。
        updatedAt: Math.max(existing.updatedAt, tab.updatedAt || this.now()),
      });
    }
    const ts = this.now();
    const meta: ConversationMeta = {
      id: this.newId(),
      name: tab.title,
      createdAt: tab.createdAt || ts,
      updatedAt: tab.updatedAt || ts,
      backend: tab.backend,
      tabId: tab.id,
      ...(tab.cliSessionId ? { cliSessionId: tab.cliSessionId } : {}),
    };
    this.writeIndex([...this.idx(), meta]);
    this.writeMessagesNow(meta.id, []);
    return meta;
  }

  /** 删除与某 CLI 标签绑定的侧栏项（不关标签本身） */
  removeByTabId(tabId: string): void {
    const hit = this.findByTabId(tabId);
    if (hit) this.delete(hit.id);
  }

  /**
   * 分叉：复制源会话消息到新会话（可换后端 / 绑定新 tabId）。
   * 不销毁源。CLI 目标若消息应写入 harness，调用方自行 seed，并把 messages 传空数组。
   */
  fork(sourceId: string, opts: ForkConversationOpts = {}): ConversationMeta {
    const src = this.get(sourceId);
    if (!src) throw new Error(`unknown conversation: ${sourceId}`);
    const msgs = opts.messages ?? this.getMessages(sourceId);
    const name = opts.name ?? t('ui.cli-monitor.copy', src.name);
    const backend = opts.backend ?? src.backend;
    const cwd = backend === 'nomi' ? (opts.cwd ?? src.cwd) : undefined;
    const meta = this.create({
      name,
      backend,
      tabId: opts.tabId,
      ...(cwd ? { cwd } : {}),
      activate: true,
    });
    if (msgs.length) {
      // 新 id，避免与源冲突
      const copied = msgs.map((m, i) => ({
        ...m,
        id: `${meta.id}_${i}_${m.id}`,
      }));
      const copiedMessages = copied.slice(-this.maxMessages);
      this.remember(meta.id, copiedMessages, this.writeMessagesNow(meta.id, copiedMessages));
      this.updatePreview(meta.id, copiedMessages);
      this.touch(meta.id);
    }
    return this.get(meta.id)!;
  }

  delete(id: string): void {
    clearNomiAutoTitle(id);
    const removed = this.get(id);
    const remaining = this.idx().filter((c) => c.id !== id);
    this.writeIndex(remaining);
    this.pending.delete(messagesKey(id));
    this.storage.removeItem(messagesKey(id));
    // 腾出了空间：之前存储满了没写进的会话可以再试
    this.quotaFailed.clear();
    this.forget(id);
    this.dropPreview(id);
    if (this.readCurrent() === id) {
      // 当前会话被删：优先切到同后端最近更新的会话；没有则留空（不隐式新建 / 不跨端跳）
      const sameBackend = removed
        ? remaining.filter((c) => c.backend === removed.backend)
        : remaining;
      const next = sameBackend.reduce<ConversationMeta | undefined>(
        (acc, c) => (!acc || c.updatedAt > acc.updatedAt ? c : acc),
        undefined,
      );
      if (next) {
        this.writeCurrent(next.id);
        if (next.backend === 'nomi' && !next.tabId) this.writeLastNomi(next.id);
      } else this.writeCurrent(undefined);
    }
    // 侧栏刷新 + App 丢掉该会话私有 composer 草稿（nomi:/tab:）
    if (removed) {
      notifyConversationsChanged({
        removed: [{ id: removed.id, ...(removed.tabId ? { tabId: removed.tabId } : {}) }],
      });
    }
  }

  private touch(id: string, message?: ChatMessage): void {
    this.writeIndex(
      this.idx().map((c) => {
        if (c.id !== id) return c;
        const cleaned =
          message && message.role === 'user' && isDefaultChatName(c.name)
            ? splitFileAttachments(message.content).text.replace(/\s+/g, ' ').trim().slice(0, 30)
            : '';
        const named = cleaned || c.name;
        return { ...c, name: named, updatedAt: this.now(), modelId: message?.modelId ?? c.modelId };
      }),
    );
  }

  /** 旧版无 backend 的行 → nomi；非法 backend 也回退 nomi */
  private migrateBackends(): void {
    const list = this.read<Array<Partial<ConversationMeta> & { id: string }>>(INDEX_KEY);
    if (!list || list.length === 0) return;
    let changed = false;
    const next = list.map((c) => {
      if (isConversationBackend(c.backend)) return c as ConversationMeta;
      changed = true;
      return { ...c, backend: 'nomi' as const } as ConversationMeta;
    });
    if (changed) this.writeIndex(next);
  }

  private migrateLegacy(): void {
    const legacy = this.read<ChatMessage[]>(LEGACY_HISTORY_KEY);
    if (!legacy) return;
    this.storage.removeItem(LEGACY_HISTORY_KEY);
    if (legacy.length === 0) return;
    const meta = this.create(t('ui.chat-settings.history'));
    const messages = legacy.slice(-this.maxMessages);
    this.remember(meta.id, messages, this.writeMessagesNow(meta.id, messages));
  }

  /** 把一份消息放到缓存末尾（最近使用），不触发淘汰。 */
  private touchCache(id: string, messages: ChatMessage[]): ChatMessage[] {
    this.messagesCache.delete(id);
    this.messagesCache.set(id, messages);
    return messages;
  }

  private forget(id: string): void {
    this.messagesCache.delete(id);
    this.cachedChars -= this.cacheChars.get(id) ?? 0;
    this.cacheChars.delete(id);
  }

  /**
   * 写入缓存并丢掉最久未用、且不是当前会话的那几份：超出份数上限或字符预算都会淘汰
   * （chars = 这份消息的 JSON 长度）。
   */
  private remember(id: string, messages: ChatMessage[], chars: number): void {
    this.touchCache(id, messages);
    this.setChars(id, chars);
  }

  /** 更新一份缓存的字符数（不改 LRU 顺序），超出预算时淘汰 */
  private setChars(id: string, chars: number): void {
    this.cachedChars += chars - (this.cacheChars.get(id) ?? 0);
    this.cacheChars.set(id, chars);
    const pin = this.currentId();
    while (
      this.messagesCache.size > this.maxCachedConversations ||
      (this.cachedChars > this.maxCachedChars && this.messagesCache.size > 1)
    ) {
      let victim: string | undefined;
      for (const key of this.messagesCache.keys()) {
        if (key !== pin) {
          victim = key;
          break;
        }
      }
      if (!victim) break;
      this.forget(victim);
    }
  }

  private readRaw(key: string): string | null {
    // 读之前先把这个 key 合并中的写盘，读到的总是最新的
    if (this.pending.has(key)) this.flushKey(key);
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  private parse<T>(raw: string): T | undefined {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  private read<T>(key: string): T | undefined {
    const raw = this.readRaw(key);
    return raw ? this.parse<T>(raw) : undefined;
  }

  /** Returns the JSON length written (0 when serialization failed). */
  private write(key: string, value: unknown): number {
    let json = '';
    try {
      json = JSON.stringify(value);
      this.storage.setItem(key, json);
      if (this.quotaFailed.delete(key)) log.info('storage write recovered', { key });
    } catch (e) {
      if (isQuotaError(e)) {
        // 每个 key 只在第一次失败时告警，退避期内不再重试（见 flushKey）
        if (!this.quotaFailed.has(key))
          log.warn('localStorage is full; conversation not saved', { key, chars: json.length });
        this.quotaFailed.set(key, this.now());
      } else {
        log.warn('storage write failed', {
          key,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return json.length;
  }
}

/** 第一条用户消息去掉附件后的前 PREVIEW_LEN 字（没有用户消息为空串） */
function previewOf(messages: readonly ChatMessage[]): string {
  const text = messages.find((m) => m.role === 'user')?.content ?? '';
  return splitFileAttachments(text).text.slice(0, PREVIEW_LEN);
}

/** 一条消息的 JSON 长度（缓存字符预算的估算；只序列化这一条，不是整段历史） */
function approxJsonLength(message: ChatMessage): number {
  try {
    return JSON.stringify(message).length;
  } catch {
    return 2;
  }
}
