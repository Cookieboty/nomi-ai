/**
 * ConversationStore —— 按会话持久化聊天记录（渲染进程 localStorage）。
 *
 * 存储布局：
 *   ai-chat:conversations          → ChatSession 元信息列表（不含 messages）
 *   ai-chat:conversation:<id>      → 该会话的 ChatMessage[]
 *   ai-chat:currentConversation    → 当前会话 id
 * 旧版单会话 `ai-chat:history` 在首次访问时迁移为一个会话。
 * 无 backend 字段的旧行迁移为 nomi。
 * 无 localStorage（测试 / 非浏览器）时退化为内存存储。
 */

import { t } from '@nomi-ai/ui';

import type { ChatMessage, ChatSession, ConversationBackend } from '../types/chat';
import { isConversationBackend } from '../types/chat';

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
const messagesKey = (id: string) => `ai-chat:conversation:${id}`;

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
   * 同时留在内存里的会话份数（LRU）。当前会话不会被淘汰。
   * 默认 4：切换历史时重新从 localStorage 读取，避免把每段对话的正文和轨迹都钉在堆上。
   */
  maxCachedConversations?: number;
  now?: () => number;
  newId?: () => string;
}

export interface CreateConversationOpts {
  name?: string;
  backend?: ConversationBackend;
  tabId?: string;
  /** 创建后是否设为当前会话，默认 true */
  activate?: boolean;
}

export interface ForkConversationOpts {
  /** 目标后端；默认与源相同 */
  backend?: ConversationBackend;
  tabId?: string;
  name?: string;
  /** 覆盖要复制的消息；默认复制源会话全部消息 */
  messages?: ChatMessage[];
}

/** 会话列表被外部改动（分叉等）后在 window 上广播，侧栏据此立即刷新 */
export const CONVERSATIONS_CHANGED_EVENT = 'nomi:conversations-changed';

export function notifyConversationsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(CONVERSATIONS_CHANGED_EVENT));
}

export class ConversationStore {
  private readonly storage: KeyValueStorage;
  private readonly now: () => number;
  private readonly newId: () => string;
  /** 避免每次切换会话都在渲染线程重复 JSON.parse 整段历史。超出上限按 LRU 丢掉。 */
  private readonly messagesCache = new Map<string, ChatMessage[]>();
  maxMessages: number;
  private readonly maxCachedConversations: number;

  constructor(opts: ConversationStoreOptions = {}) {
    this.storage = opts.storage ?? defaultStorage();
    this.maxMessages = opts.maxMessages ?? 1000;
    this.maxCachedConversations = Math.max(1, opts.maxCachedConversations ?? 4);
    this.now = opts.now ?? Date.now;
    this.newId =
      opts.newId ??
      (() => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    this.migrateLegacy();
    this.migrateBackends();
  }

  list(): ConversationMeta[] {
    return this.read<ConversationMeta[]>(INDEX_KEY) ?? [];
  }

  listByBackend(backend: ConversationBackend): ConversationMeta[] {
    return this.list().filter((c) => c.backend === backend);
  }

  /** 当前会话 id；不存在时返回 undefined（不隐式创建） */
  currentId(): string | undefined {
    const id = this.read<string>(CURRENT_KEY);
    if (id && this.list().some((c) => c.id === id)) return id;
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
    const rec = this.read<string>(LAST_NOMI_KEY);
    if (rec && this.isNomi(rec)) return rec;
    return this.list()
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
    return this.list().find((c) => c.id === id);
  }

  findByTabId(tabId: string): ConversationMeta | undefined {
    return this.list().find((c) => c.tabId === tabId);
  }

  create(nameOrOpts?: string | CreateConversationOpts): ConversationMeta {
    const opts: CreateConversationOpts =
      typeof nameOrOpts === 'string' || nameOrOpts === undefined
        ? { name: nameOrOpts }
        : nameOrOpts;
    const ts = this.now();
    const meta: ConversationMeta = {
      id: this.newId(),
      name: opts.name ?? t('新对话'),
      createdAt: ts,
      updatedAt: ts,
      backend: opts.backend ?? 'nomi',
      ...(opts.tabId ? { tabId: opts.tabId } : {}),
    };
    this.write(INDEX_KEY, [...this.list(), meta]);
    this.write(messagesKey(meta.id), []);
    // 先记下当前会话，再放入缓存，这样淘汰时不会把刚建的会话丢掉
    if (opts.activate !== false) {
      this.write(CURRENT_KEY, meta.id);
      if (meta.backend === 'nomi' && !meta.tabId) this.write(LAST_NOMI_KEY, meta.id);
    }
    this.remember(meta.id, []);
    return meta;
  }

  switchTo(id: string): void {
    if (!this.list().some((c) => c.id === id)) throw new Error(`unknown conversation: ${id}`);
    this.write(CURRENT_KEY, id);
    if (this.isNomi(id)) this.write(LAST_NOMI_KEY, id);
  }

  getMessages(id: string | undefined = this.currentId()): ChatMessage[] {
    if (!id) return [];
    const cached = this.messagesCache.get(id);
    if (cached) return this.touchCache(id, cached);
    const messages = this.read<ChatMessage[]>(messagesKey(id)) ?? [];
    this.remember(id, messages);
    return messages;
  }

  /**
   * 侧栏搜索用：只要第一条用户消息的前若干字。
   * 命中缓存时直接读；未命中则解析后立刻丢掉，不进入 messagesCache。
   */
  firstUserPreview(id: string, maxLen = 300): string {
    const cached = this.messagesCache.get(id);
    const messages = cached ?? this.read<ChatMessage[]>(messagesKey(id));
    const text = messages?.find((m) => m.role === 'user')?.content ?? '';
    return text.slice(0, maxLen);
  }

  setMessages(id: string, messages: ChatMessage[]): void {
    const next = messages.slice(-this.maxMessages);
    this.remember(id, next);
    this.write(messagesKey(id), next);
    this.touch(id);
  }

  append(message: ChatMessage, id: string | undefined = this.currentId()): void {
    if (!id) return;
    const next = [...this.getMessages(id), message].slice(-this.maxMessages);
    this.remember(id, next);
    this.write(messagesKey(id), next);
    this.touch(id, message);
  }

  /** 清空会话消息（会话本身保留） */
  clear(id: string | undefined = this.currentId()): void {
    if (!id) return;
    this.remember(id, []);
    this.write(messagesKey(id), []);
    this.touch(id);
  }

  updateMeta(
    id: string,
    patch: Partial<Omit<ConversationMeta, 'id' | 'createdAt'>>,
  ): ConversationMeta {
    let updated: ConversationMeta | undefined;
    this.write(
      INDEX_KEY,
      this.list().map((c) => {
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
   * 同步 CLI 标签到侧栏元信息：已有则更新标题 / 时间 / 后端；没有则新建。
   * 返回会话元信息。
   */
  upsertFromTab(tab: {
    id: string;
    title: string;
    backend: ConversationBackend;
    createdAt: number;
    updatedAt: number;
  }): ConversationMeta {
    if (tab.backend === 'nomi') {
      throw new Error('CLI tab sync requires a non-nomi backend');
    }
    const existing = this.findByTabId(tab.id);
    if (existing) {
      return this.updateMeta(existing.id, {
        name: tab.title,
        backend: tab.backend,
        tabId: tab.id,
        updatedAt: tab.updatedAt,
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
    };
    this.write(INDEX_KEY, [...this.list(), meta]);
    this.write(messagesKey(meta.id), []);
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
    const name = opts.name ?? t('{0} (副本)', src.name);
    const meta = this.create({
      name,
      backend: opts.backend ?? src.backend,
      tabId: opts.tabId,
      activate: true,
    });
    if (msgs.length) {
      // 新 id，避免与源冲突
      const copied = msgs.map((m, i) => ({
        ...m,
        id: `${meta.id}_${i}_${m.id}`,
      }));
      const copiedMessages = copied.slice(-this.maxMessages);
      this.remember(meta.id, copiedMessages);
      this.write(messagesKey(meta.id), copiedMessages);
      this.touch(meta.id);
    }
    return this.get(meta.id)!;
  }

  delete(id: string): void {
    const removed = this.list().find((c) => c.id === id);
    const remaining = this.list().filter((c) => c.id !== id);
    this.write(INDEX_KEY, remaining);
    this.storage.removeItem(messagesKey(id));
    this.messagesCache.delete(id);
    if (this.read<string>(CURRENT_KEY) !== id) return;
    // 当前会话被删：优先切到同后端最近更新的会话；没有则留空（不隐式新建 / 不跨端跳）
    const sameBackend = removed
      ? remaining.filter((c) => c.backend === removed.backend)
      : remaining;
    const next = sameBackend.reduce<ConversationMeta | undefined>(
      (acc, c) => (!acc || c.updatedAt > acc.updatedAt ? c : acc),
      undefined,
    );
    if (next) {
      this.write(CURRENT_KEY, next.id);
      if (next.backend === 'nomi' && !next.tabId) this.write(LAST_NOMI_KEY, next.id);
    } else this.storage.removeItem(CURRENT_KEY);
  }

  private touch(id: string, message?: ChatMessage): void {
    this.write(
      INDEX_KEY,
      this.list().map((c) => {
        if (c.id !== id) return c;
        const named =
          message && message.role === 'user' && (c.name === '新对话' || c.name === t('新对话'))
            ? message.content.slice(0, 30)
            : c.name;
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
    if (changed) this.write(INDEX_KEY, next);
  }

  private migrateLegacy(): void {
    const legacy = this.read<ChatMessage[]>(LEGACY_HISTORY_KEY);
    if (!legacy) return;
    this.storage.removeItem(LEGACY_HISTORY_KEY);
    if (legacy.length === 0) return;
    const meta = this.create(t('历史对话'));
    const messages = legacy.slice(-this.maxMessages);
    this.remember(meta.id, messages);
    this.write(messagesKey(meta.id), messages);
  }

  /** 把一份消息放到缓存末尾（最近使用），不触发淘汰。 */
  private touchCache(id: string, messages: ChatMessage[]): ChatMessage[] {
    this.messagesCache.delete(id);
    this.messagesCache.set(id, messages);
    return messages;
  }

  /** 写入缓存并丢掉最久未用、且不是当前会话的那几份。 */
  private remember(id: string, messages: ChatMessage[]): void {
    this.touchCache(id, messages);
    const pin = this.currentId();
    while (this.messagesCache.size > this.maxCachedConversations) {
      let victim: string | undefined;
      for (const key of this.messagesCache.keys()) {
        if (key !== pin) {
          victim = key;
          break;
        }
      }
      if (!victim) break;
      this.messagesCache.delete(victim);
    }
  }

  private read<T>(key: string): T | undefined {
    try {
      const raw = this.storage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined;
    }
  }

  private write(key: string, value: unknown): void {
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota / disabled storage */
    }
  }
}
