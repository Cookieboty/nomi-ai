/**
 * ConversationStore —— 对话窗口的会话存储（视图侧）。
 *
 * 数据在 Go 内核（契约 `conversations.*`，userData/conversations/：索引 + 每个会话一个 jsonl，见
 * docs/features/chat.md）。这里是它的同步门面：
 * - 索引（元信息、第一条用户消息预览、条数、当前会话）在第一次渲染前取好（conversationBoot），之后在内存里读写；
 * - 消息按会话缓存（LRU，份数 + 字符预算，当前会话不淘汰）。没缓存的会话 `getMessages` 返回 []：
 *   打开会话的地方都先 `await loadMessages(id)`（切换会话、读历史、分叉都已这样做）；
 *   判断有没有消息用 `hasMessages`（没加载时看内核给的条数）；
 * - 写：内存立即更新，内核写入排进一个有序队列（一次一个，排着的相邻追加合并成一次）。追加只发新消息，
 *   不序列化整段历史；`flush()` 等队列写完（关窗前）。读一个没缓存的会话前也先等队列写完；
 * - 写失败：暂时的错误（连接断了、内核 IO 出错）退避重试；重试用尽时这一条留在队首（不丢），过一会儿或
 *   下一次写入时再试，并提示用户一次（`CONVERSATION_WRITE_FAILED_EVENT`）。内核说会话不在
 *   （CONVERSATION_NOT_FOUND：新建没写成、索引重建过）就按内存里的元信息 + 全部消息重新建一份再继续；
 *   重试追加时也整份写（不会追加成两份）。有排着的写入的会话不从缓存里淘汰；
 * - 别的窗口写了（`conversations.changed`，来源不是自己）：重新取索引、丢掉那些会话的缓存。
 * 没有内核（测试 / 浏览器预览）时只在内存里，不淘汰。
 * 旧的 localStorage 布局由 conversationMigration 一次性导入内核。
 */

import { createLogger, t } from '@nomi-ai/ui';

import type { ChatMessage, ConversationBackend } from '../types/chat';
import { isConversationBackend } from '../types/chat';

import {
  isConversationNotFound,
  isPermanentWriteError,
  type ConversationKernel,
  type ConversationMeta,
  type ConversationSnapshot,
} from './conversationKernel';
import { splitFileAttachments } from './fileAttachments';
import { clearNomiAutoTitle, isDefaultChatName } from './sessionTitle';

export type { ConversationMeta } from './conversationKernel';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createMemoryStorage(): KeyValueStorage & {
  readonly length: number;
  key(i: number): string | null;
} {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

const PREVIEW_LEN = 300;

const log = createLogger('conversationStore');

export interface ConversationStoreOptions {
  /** 内核端口；不给 = 只在内存里（测试 / 浏览器预览），消息缓存不淘汰 */
  kernel?: ConversationKernel;
  /** 启动时取好的索引（conversationBoot）；不给 = 空 */
  snapshot?: ConversationSnapshot;
  /** 每个会话最多保留的消息条数（超出丢弃最旧的），默认 1000 */
  maxMessages?: number;
  /** 同时留在内存里的会话份数（LRU）。当前会话不会被淘汰。默认 12。 */
  maxCachedConversations?: number;
  /**
   * 内存里消息缓存的总字符预算（按 JSON 长度计），默认 8M 字符：普通长度的会话能留住 8–12 段，
   * 少数巨型会话也不会把堆撑爆。当前会话不会被淘汰。
   */
  maxCachedChars?: number;
  now?: () => number;
  newId?: () => string;
  /** 写失败后的退避（毫秒），用尽算「写不进去」；默认 [300, 1000, 3000] */
  retryDelays?: number[];
  /** 写不进去之后隔多久再试一次（毫秒），默认 15000 */
  stalledRetryMs?: number;
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
  /** 覆盖要复制的消息；默认复制源会话全部消息（源会话须已加载：先 await loadMessages） */
  messages?: ChatMessage[];
}

/** 会话列表被外部改动（分叉、别的窗口写入等）后在 window 上广播，侧栏据此立即刷新 */
export const CONVERSATIONS_CHANGED_EVENT = 'nomi:conversations-changed';

export type ConversationsChangedDetail = {
  /** 删除路径带上被删项，App 可直接 drop 私有草稿（不依赖 prev 快照） */
  removed?: Array<{ id: string; tabId?: string }>;
};

export function notifyConversationsChanged(detail?: ConversationsChangedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CONVERSATIONS_CHANGED_EVENT, { detail }));
}

/**
 * 对话记录写不进内核（重试用尽 / 被拒收）：在 window 上广播，App 提示一次（不打断）。
 * 恢复后再出问题会再广播一次。
 */
export const CONVERSATION_WRITE_FAILED_EVENT = 'nomi:conversation-write-failed';

/** 排队的内核写入；append / pointers 与紧挨着的同类合并 */
type WriteOp =
  | {
      kind: 'append';
      id: string;
      messages: ChatMessage[];
      meta?: ConversationMeta;
      preview?: string;
      max?: number;
    }
  | {
      kind: 'replace';
      id: string;
      messages: ChatMessage[];
      meta?: ConversationMeta;
      preview?: string;
    }
  | { kind: 'pointers'; current?: string | null; lastNomi?: string | null }
  | { kind: 'call'; name: string; id?: string; run: (k: ConversationKernel) => Promise<unknown> };

const opId = (op: WriteOp): string | undefined => (op.kind === 'pointers' ? undefined : op.id);
const opName = (op: WriteOp): string => (op.kind === 'call' ? op.name : op.kind);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ConversationStore {
  private readonly kernel: ConversationKernel | undefined;
  private readonly now: () => number;
  private readonly newId: () => string;
  /** 已加载的会话消息（LRU：Map 的顺序 = 最近使用在后） */
  private readonly messagesCache = new Map<string, ChatMessage[]>();
  /** JSON length of each cached conversation (for the char budget) */
  private readonly cacheChars = new Map<string, number>();
  private cachedChars = 0;
  maxMessages: number;
  private readonly maxCachedConversations: number;
  private readonly maxCachedChars: number;
  private index: ConversationMeta[];
  private current: string | undefined;
  private lastNomi: string | undefined;
  private previews: Record<string, string>;
  /** 没加载的会话的消息条数（内核给的，追加时跟着加） */
  private readonly counts = new Map<string, number>();
  /** 写队列（还没开始的）；drain 一次跑一个 */
  private readonly ops: WriteOp[] = [];
  /** 正在写的那一条（已从队列取出） */
  private inflight: WriteOp | undefined;
  /** 整份重写已拍进快照的排队操作：不再往里合并新的追加，重写成功后只删这些 */
  private readonly sealed = new WeakSet<WriteOp>();
  private draining: Promise<void> | undefined;
  private readonly retryDelays: number[];
  private readonly stalledRetryMs: number;
  /** 写不进去（队首那条重试用尽）：等 retryTimer 或下一次写入再试 */
  private stalled = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** 这一轮故障已经提示过用户 */
  private failureNotified = false;
  /** 写不进去期间别的窗口写了：恢复后再重新取索引（不能拿内核的旧索引盖掉还没写进去的） */
  private pendingRefresh: string[] | undefined;
  /** 每个会话本地写过几次：加载期间又写了就重新加载，不用过期的结果 */
  private readonly writes = new Map<string, number>();
  private readonly loads = new Map<string, Promise<ChatMessage[]>>();
  private readonly offKernel: () => void;
  private disposed = false;
  /** 新 Nomi 对话没指定工作区时用的目录（IPCClient 注入主标签当前的目录；缺省没有） */
  defaultNomiCwd: () => string | undefined = () => undefined;

  constructor(opts: ConversationStoreOptions = {}) {
    this.kernel = opts.kernel;
    this.maxMessages = opts.maxMessages ?? 1000;
    this.maxCachedConversations = Math.max(1, opts.maxCachedConversations ?? 12);
    this.maxCachedChars = Math.max(0, opts.maxCachedChars ?? 8_000_000);
    this.now = opts.now ?? Date.now;
    this.retryDelays = opts.retryDelays ?? [300, 1000, 3000];
    this.stalledRetryMs = opts.stalledRetryMs ?? 15_000;
    this.newId =
      opts.newId ??
      (() => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    this.index = [];
    this.previews = {};
    this.applySnapshot(opts.snapshot);
    this.offKernel =
      this.kernel?.onChanged?.((e) => {
        if (e.source && e.source === this.kernel?.source) return;
        void this.refreshFromKernel(e.ids);
      }) ?? (() => undefined);
  }

  private applySnapshot(s: ConversationSnapshot | undefined): void {
    // 旧版无 backend 的行 → nomi；非法 backend 也回退 nomi（只在内存里改，下次写元信息时落盘）
    this.index = (s?.conversations ?? []).map((c) =>
      isConversationBackend(c.backend) ? c : { ...c, backend: 'nomi' as const },
    );
    this.previews = { ...(s?.previews ?? {}) };
    this.counts.clear();
    for (const [id, n] of Object.entries(s?.counts ?? {})) this.counts.set(id, n);
    this.current = s?.current;
    this.lastNomi = s?.lastNomi;
  }

  /** 别的窗口写了：等自己的写完，重新取索引，丢掉变了的会话的缓存 */
  private async refreshFromKernel(ids: string[]): Promise<void> {
    if (!this.kernel || this.disposed) return;
    try {
      await this.flush();
      if (this.hasPendingWrites()) {
        // 自己还有没写进去的：内核的索引缺这些，先不套用，写进去之后再取
        this.pendingRefresh = [...(this.pendingRefresh ?? []), ...ids];
        return;
      }
      const s = await this.kernel.state();
      if (this.disposed || this.hasPendingWrites()) {
        if (!this.disposed) this.pendingRefresh = [...(this.pendingRefresh ?? []), ...ids];
        return;
      }
      this.applySnapshot(s);
      for (const id of ids) this.forget(id);
      for (const id of [...this.messagesCache.keys()]) if (!this.get(id)) this.forget(id);
      notifyConversationsChanged();
    } catch (e) {
      log.warn('conversation index refresh failed', e);
    }
  }

  list(): ConversationMeta[] {
    return [...this.index];
  }

  /** 停止接收内核的变更通知（调用方先 await flush()） */
  dispose(): void {
    this.disposed = true;
    this.offKernel();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /**
   * 等排着的内核写入都写完（关窗 / 释放前调用）。写不进去（重试用尽）时不一直等：这一轮试完就返回，
   * 没写进去的留在队列里（`hasPendingWrites()`）
   */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** 还有没写进内核的（排着的、正在写的、写不进去等着重试的） */
  hasPendingWrites(): boolean {
    return !!this.inflight || this.ops.length > 0;
  }

  private pendingFor(id: string): boolean {
    if (this.inflight && opId(this.inflight) === id) return true;
    return this.ops.some((op) => opId(op) === id);
  }

  /** Drop the in-memory message caches (the index stays). */
  invalidate(): void {
    if (!this.kernel) return; // 只在内存里：缓存就是数据
    this.messagesCache.clear();
    this.cacheChars.clear();
    this.cachedChars = 0;
  }

  listByBackend(backend: ConversationBackend): ConversationMeta[] {
    return this.index.filter((c) => c.backend === backend);
  }

  /** 当前会话 id；不存在时返回 undefined（不隐式创建） */
  currentId(): string | undefined {
    const id = this.current;
    if (id && this.index.some((c) => c.id === id)) return id;
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
    const rec = this.lastNomi;
    if (rec && this.isNomi(rec) && !this.get(rec)?.archivedAt) return rec;
    return this.index
      .filter((c) => c.backend === 'nomi' && !c.tabId && !c.archivedAt)
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
    return this.index.find((c) => c.id === id);
  }

  findByTabId(tabId: string): ConversationMeta | undefined {
    return this.index.find((c) => c.tabId === tabId);
  }

  findByCliSessionId(
    backend: ConversationBackend,
    cliSessionId: string,
  ): ConversationMeta | undefined {
    return this.index.find((c) => c.backend === backend && c.cliSessionId === cliSessionId);
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
    this.index = [...this.index, meta];
    this.counts.set(meta.id, 0);
    this.previews[meta.id] = '';
    this.enqueue({
      kind: 'call',
      name: 'put',
      id: meta.id,
      run: (k) => k.put({ meta, messages: [], preview: '' }),
    });
    // 先记下当前会话，再放入缓存，这样淘汰时不会把刚建的会话丢掉
    if (opts.activate !== false) {
      const isNomi = meta.backend === 'nomi' && !meta.tabId;
      this.setPointers(meta.id, isNomi ? meta.id : undefined);
    }
    this.remember(meta.id, [], 2);
    return meta;
  }

  /** 改当前会话（同步）；要读它的消息先 await loadMessages（或用 open） */
  switchTo(id: string): void {
    const meta = this.get(id);
    if (!meta) throw new Error(`unknown conversation: ${id}`);
    const isNomi = meta.backend === 'nomi' && !meta.tabId;
    this.setPointers(
      this.current !== id ? id : undefined,
      isNomi && this.lastNomi !== id ? id : undefined,
    );
  }

  /** 切到这个会话并加载它的消息 */
  async open(id: string): Promise<ChatMessage[]> {
    this.switchTo(id);
    return this.loadMessages(id);
  }

  /** 只改变了的指针才写 */
  private setPointers(current: string | null | undefined, lastNomi: string | undefined): void {
    const op: { kind: 'pointers'; current?: string | null; lastNomi?: string | null } = {
      kind: 'pointers',
    };
    if (current !== undefined && (current ?? undefined) !== this.current) {
      this.current = current ?? undefined;
      op.current = current;
    }
    if (lastNomi !== undefined && lastNomi !== this.lastNomi) {
      this.lastNomi = lastNomi;
      op.lastNomi = lastNomi;
    }
    if (op.current !== undefined || op.lastNomi !== undefined) this.enqueue(op);
  }

  /** 消息已在内存里（getMessages 拿到的就是全部） */
  isLoaded(id: string): boolean {
    return !this.kernel || this.messagesCache.has(id);
  }

  /** 这个会话有没有消息（没加载时看内核给的条数） */
  hasMessages(id: string): boolean {
    const cached = this.messagesCache.get(id);
    if (cached) return cached.length > 0;
    return (this.counts.get(id) ?? 0) > 0;
  }

  /**
   * 同步读消息：已加载的会话返回全部；没加载的返回 []（打开会话的地方要先 await loadMessages）。
   */
  getMessages(id: string | undefined = this.currentId()): ChatMessage[] {
    if (!id) return [];
    const cached = this.messagesCache.get(id);
    if (cached) return this.touchCache(id, cached);
    if (!this.kernel) {
      if (!this.get(id)) return [];
      this.remember(id, [], 2);
      return this.messagesCache.get(id)!;
    }
    return [];
  }

  /** 加载一个会话的消息（已缓存的直接返回；同一会话并发加载只发一次） */
  loadMessages(id: string | undefined = this.currentId()): Promise<ChatMessage[]> {
    if (!id) return Promise.resolve([]);
    const cached = this.messagesCache.get(id);
    if (cached || !this.kernel) return Promise.resolve(this.getMessages(id));
    const inflight = this.loads.get(id);
    if (inflight) return inflight;
    const p = this.fetchMessages(id).finally(() => this.loads.delete(id));
    this.loads.set(id, p);
    return p;
  }

  private async fetchMessages(id: string): Promise<ChatMessage[]> {
    const kernel = this.kernel!;
    for (let attempt = 0; ; attempt++) {
      // 先等排着的写入写完：读到的总是最新的
      await this.flush();
      const before = this.writes.get(id) ?? 0;
      const r = await kernel.messages(id, this.maxMessages);
      const cached = this.messagesCache.get(id);
      if (cached) return this.touchCache(id, cached);
      if (!this.get(id)) return [];
      // 加载期间本地又写了：这次结果过期，重读（写入在队列里，下一轮先等它写完）
      if ((this.writes.get(id) ?? 0) !== before && attempt < 3) continue;
      // 写不进去、还排着的（flush 没等到）：叠上去，缓存里的就是内核写完之后会有的
      const messages = this.withPending(id, r.messages).slice(-this.maxMessages);
      this.counts.set(id, messages.length);
      this.remember(id, messages, r.bytes ?? approxChars(messages));
      return messages;
    }
  }

  private withPending(id: string, loaded: ChatMessage[]): ChatMessage[] {
    let out = loaded;
    for (const op of this.inflight ? [this.inflight, ...this.ops] : this.ops) {
      if (opId(op) !== id) continue;
      if (op.kind === 'replace') out = [...op.messages];
      else if (op.kind === 'append') out = [...out, ...op.messages];
    }
    return out;
  }

  /**
   * 侧栏搜索用：第一条用户消息的前若干字（内核随索引给的预览；没有时从已加载的消息算）。
   */
  firstUserPreview(id: string, maxLen = PREVIEW_LEN): string {
    const fits = maxLen <= PREVIEW_LEN;
    const known =
      fits && Object.prototype.hasOwnProperty.call(this.previews, id)
        ? this.previews[id]
        : undefined;
    if (known !== undefined) return known.slice(0, maxLen);
    const cached = this.messagesCache.get(id);
    if (!cached) return '';
    if (fits && this.get(id)) {
      // 旧会话还没有预览：算一次记下来（随元信息写进内核）
      const preview = previewOf(cached);
      this.previews[id] = preview;
      const meta = this.get(id)!;
      this.enqueue({ kind: 'call', name: 'put', id, run: (k) => k.put({ meta, preview }) });
      return preview.slice(0, maxLen);
    }
    const text = cached.find((m) => m.role === 'user')?.content ?? '';
    return splitFileAttachments(text).text.slice(0, maxLen);
  }

  setMessages(id: string, messages: ChatMessage[]): void {
    if (!this.get(id)) return;
    const next = messages.slice(-this.maxMessages);
    this.remember(id, next, approxChars(next));
    this.counts.set(id, next.length);
    const preview = this.nextPreview(id, next);
    const meta = this.touch(id);
    this.bump(id);
    this.enqueue({ kind: 'replace', id, messages: next, ...(meta ? { meta } : {}), ...preview });
  }

  append(message: ChatMessage, id: string | undefined = this.currentId()): void {
    if (!id || !this.get(id)) return;
    const cached = this.messagesCache.get(id) ?? (this.kernel ? undefined : this.getMessages(id));
    let preview: { preview?: string };
    if (cached) {
      const next = [...cached, message].slice(-this.maxMessages);
      const estimate = (this.cacheChars.get(id) ?? 2) + approxJsonLength(message) + 1;
      this.remember(id, next, estimate);
      this.counts.set(id, next.length);
      preview = this.nextPreview(id, next);
    } else {
      // 没加载的会话（在后台回复完、已被淘汰）：只追加，不读整段历史；预览只在还没有时补上
      this.counts.set(id, Math.min(this.maxMessages, (this.counts.get(id) ?? 0) + 1));
      preview =
        !this.previews[id] && message.role === 'user' ? this.nextPreview(id, [message]) : {};
    }
    const meta = this.touch(id, message);
    this.bump(id);
    this.enqueue({
      kind: 'append',
      id,
      messages: [message],
      ...(meta ? { meta } : {}),
      ...preview,
      max: this.maxMessages,
    });
  }

  /** 清空会话消息（会话本身保留） */
  clear(id: string | undefined = this.currentId()): void {
    if (!id) return;
    this.setMessages(id, []);
  }

  updateMeta(
    id: string,
    patch: Partial<Omit<ConversationMeta, 'id' | 'createdAt'>>,
  ): ConversationMeta {
    let updated: ConversationMeta | undefined;
    this.index = this.index.map((c) => {
      if (c.id !== id) return c;
      updated = {
        ...c,
        ...patch,
        id: c.id,
        createdAt: c.createdAt,
        updatedAt: patch.updatedAt ?? this.now(),
      };
      return updated;
    });
    if (!updated) throw new Error(`unknown conversation: ${id}`);
    const meta = updated;
    this.enqueue({ kind: 'call', name: 'put', id, run: (k) => k.put({ meta }) });
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
    this.index = [...this.index, meta];
    this.counts.set(meta.id, 0);
    this.enqueue({
      kind: 'call',
      name: 'put',
      id: meta.id,
      run: (k) => k.put({ meta, messages: [] }),
    });
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
   * 没传 messages 时源会话须已加载（先 await loadMessages），否则抛错（不会悄悄复制成空会话）。
   */
  fork(sourceId: string, opts: ForkConversationOpts = {}): ConversationMeta {
    const src = this.get(sourceId);
    if (!src) throw new Error(`unknown conversation: ${sourceId}`);
    if (!opts.messages && !this.isLoaded(sourceId))
      throw new Error(`conversation not loaded: ${sourceId}`);
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
      this.setMessages(meta.id, copied);
    }
    return this.get(meta.id)!;
  }

  /** 归档 / 取消归档 Nomi 对话：不改更新时间；归档的是当前会话时，像删除一样切到同端最近的会话 */
  setArchived(id: string, archived: boolean): void {
    const meta = this.get(id);
    if (!meta || Boolean(meta.archivedAt) === archived) return;
    this.updateMeta(id, {
      archivedAt: archived ? this.now() : undefined,
      updatedAt: meta.updatedAt,
    });
    if (archived && this.current === id) {
      const next = this.index
        .filter((c) => c.backend === meta.backend && c.id !== id && !c.archivedAt)
        .reduce<ConversationMeta | undefined>(
          (acc, c) => (!acc || c.updatedAt > acc.updatedAt ? c : acc),
          undefined,
        );
      if (next)
        this.setPointers(next.id, next.backend === 'nomi' && !next.tabId ? next.id : undefined);
      else this.setPointers(null, undefined);
    }
    notifyConversationsChanged();
  }

  /** 置顶 / 取消置顶：不改更新时间（置顶不算一次活动） */
  setPinned(id: string, pinned: boolean): void {
    const meta = this.get(id);
    if (!meta || Boolean(meta.pinnedAt) === pinned) return;
    this.updateMeta(id, { pinnedAt: pinned ? this.now() : undefined, updatedAt: meta.updatedAt });
    notifyConversationsChanged();
  }

  delete(id: string): void {
    clearNomiAutoTitle(id);
    const removed = this.get(id);
    const remaining = this.index.filter((c) => c.id !== id);
    this.index = remaining;
    this.forget(id);
    this.counts.delete(id);
    delete this.previews[id];
    this.bump(id);
    if (removed) this.enqueue({ kind: 'call', name: 'delete', id, run: (k) => k.remove(id) });
    if (this.current === id) {
      // 当前会话被删：优先切到同后端最近更新的会话；没有则留空（不隐式新建 / 不跨端跳）
      const sameBackend = removed
        ? remaining.filter((c) => c.backend === removed.backend)
        : remaining;
      const next = sameBackend.reduce<ConversationMeta | undefined>(
        (acc, c) => (!acc || c.updatedAt > acc.updatedAt ? c : acc),
        undefined,
      );
      if (next)
        this.setPointers(next.id, next.backend === 'nomi' && !next.tabId ? next.id : undefined);
      else this.setPointers(null, undefined);
    }
    // 侧栏刷新 + App 丢掉该会话私有 composer 草稿（nomi:/tab:）
    if (removed) {
      notifyConversationsChanged({
        removed: [{ id: removed.id, ...(removed.tabId ? { tabId: removed.tabId } : {}) }],
      });
    }
  }

  /** 更新时间 / 默认标题 / 模型（只改内存，返回新的元信息由调用方随写入一起发） */
  private touch(id: string, message?: ChatMessage): ConversationMeta | undefined {
    let out: ConversationMeta | undefined;
    this.index = this.index.map((c) => {
      if (c.id !== id) return c;
      const cleaned =
        message && message.role === 'user' && isDefaultChatName(c.name)
          ? splitFileAttachments(message.content).text.replace(/\s+/g, ' ').trim().slice(0, 30)
          : '';
      const named = cleaned || c.name;
      out = { ...c, name: named, updatedAt: this.now(), modelId: message?.modelId ?? c.modelId };
      return out;
    });
    return out;
  }

  /** 预览变了才返回（随写入一起发） */
  private nextPreview(id: string, messages: readonly ChatMessage[]): { preview?: string } {
    const next = previewOf(messages);
    if (this.previews[id] === next) return {};
    this.previews[id] = next;
    return { preview: next };
  }

  private bump(id: string): void {
    this.writes.set(id, (this.writes.get(id) ?? 0) + 1);
  }

  private enqueue(op: WriteOp): void {
    if (!this.kernel) return;
    const last = this.ops[this.ops.length - 1];
    if (
      op.kind === 'append' &&
      last?.kind === 'append' &&
      last.id === op.id &&
      !this.sealed.has(last)
    ) {
      last.messages.push(...op.messages);
      if (op.meta) last.meta = op.meta;
      if (op.preview !== undefined) last.preview = op.preview;
      last.max = op.max;
    } else if (op.kind === 'pointers' && last?.kind === 'pointers') {
      if (op.current !== undefined) last.current = op.current;
      if (op.lastNomi !== undefined) last.lastNomi = op.lastNomi;
    } else {
      this.ops.push(op);
    }
    if (!this.draining) this.draining = this.drain();
  }

  private async drain(): Promise<void> {
    const kernel = this.kernel!;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    try {
      while (this.ops.length) {
        const op = this.ops.shift()!;
        this.inflight = op;
        const ok = await this.write(kernel, op);
        this.inflight = undefined;
        if (!ok) {
          // 写不进去：留在队首（不丢），过一会儿再试；提示用户一次
          this.ops.unshift(op);
          this.stall();
          return;
        }
      }
      if (this.stalled) {
        this.stalled = false;
        this.failureNotified = false;
        log.info('conversation writes recovered');
      }
      // 写完了：之前因为有排着的写入没淘汰的，现在按预算淘汰
      this.evict();
    } finally {
      this.inflight = undefined;
      this.draining = undefined;
    }
    const refresh = this.pendingRefresh;
    if (refresh && !this.disposed) {
      this.pendingRefresh = undefined;
      void this.refreshFromKernel(refresh);
    }
  }

  /** 写一条（含重试）；false = 重试用尽、还没写进去 */
  private async write(kernel: ConversationKernel, op: WriteOp): Promise<boolean> {
    const id = opId(op);
    // 整份重写这个会话（会话不在 / 重试追加）
    let resync = false;
    for (let attempt = 0; ; attempt++) {
      try {
        if (resync && id) await this.resync(kernel, op, id);
        else await this.send(kernel, op);
        return true;
      } catch (e) {
        const name = opName(op);
        const error = e instanceof Error ? e.message : String(e);
        // 写的时候会话已被删（流式回复晚到）：不是故障
        if (id && !this.get(id) && name !== 'delete') {
          log.debug('conversation write skipped', { name, id });
          return true;
        }
        if (id && !resync && isConversationNotFound(e)) {
          // 内核里没有（新建没写成 / 索引重建过）：按内存里的重新建一份
          log.warn('conversation missing in the kernel, re-creating it', { name, id });
          resync = true;
          attempt--;
          continue;
        }
        if (isPermanentWriteError(e)) {
          // 重试也没用（被拒收）：不再重试，记下并提示
          log.error('conversation write rejected', { name, id, error });
          this.notifyWriteFailure();
          return true;
        }
        if (attempt >= this.retryDelays.length) {
          log.warn('conversation write failed, will retry', { name, id, error });
          return false;
        }
        // 追加可能已经落盘、只是回复没收到：有整份的就整份写，不会追加成两份
        if (id && (op.kind === 'append' || op.kind === 'replace') && this.messagesCache.has(id))
          resync = true;
        await sleep(this.retryDelays[attempt]!);
        if (this.disposed) return false;
      }
    }
  }

  private async send(kernel: ConversationKernel, op: WriteOp): Promise<void> {
    if (op.kind === 'append') {
      const { kind: _k, ...input } = op;
      await kernel.append(input);
    } else if (op.kind === 'replace') {
      const { kind: _k, ...input } = op;
      await kernel.replace(input);
    } else if (op.kind === 'pointers') {
      const { kind: _k, ...input } = op;
      await kernel.setPointers(input);
    } else {
      await op.run(kernel);
    }
  }

  /**
   * 按内存里的元信息 + 消息整份写（put 会话不在就新建）。缓存里有整份消息时，拍快照那一刻队列里这个会话
   * 排着的追加 / 替换都已包含在内，写成后去掉——只去掉这些（按对象认），put 等待期间新排进来的照常写；
   * 它们被封住，新的追加不会合并进去跟着被去掉。没缓存时只能写这一条带的消息（内核里本来就没有更早的）。
   */
  private async resync(kernel: ConversationKernel, op: WriteOp, id: string): Promise<void> {
    if (op.kind === 'call') return void (await op.run(kernel));
    const meta = this.get(id);
    if (!meta) return;
    const cached = this.messagesCache.get(id);
    const fallback = op.kind === 'append' || op.kind === 'replace' ? op.messages : undefined;
    const messages = cached ? [...cached] : fallback;
    const preview = this.previews[id] ?? (messages ? previewOf(messages) : undefined);
    const covered = cached
      ? this.ops.filter((o) => (o.kind === 'append' || o.kind === 'replace') && o.id === id)
      : [];
    for (const o of covered) this.sealed.add(o);
    try {
      await kernel.put({
        meta,
        ...(messages ? { messages } : {}),
        ...(preview !== undefined ? { preview } : {}),
      });
    } catch (e) {
      for (const o of covered) this.sealed.delete(o);
      throw e;
    }
    if (!messages) await this.send(kernel, op);
    for (const o of covered) {
      const i = this.ops.indexOf(o);
      if (i >= 0) this.ops.splice(i, 1);
    }
  }

  private stall(): void {
    this.stalled = true;
    if (this.disposed) return;
    this.notifyWriteFailure();
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.draining && this.ops.length && !this.disposed) this.draining = this.drain();
    }, this.stalledRetryMs);
  }

  private notifyWriteFailure(): void {
    if (this.failureNotified) return;
    this.failureNotified = true;
    if (typeof window !== 'undefined')
      window.dispatchEvent(new CustomEvent(CONVERSATION_WRITE_FAILED_EVENT));
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
   * （chars = 这份消息的 JSON 长度）。没有内核时不淘汰（缓存就是数据）。
   */
  private remember(id: string, messages: ChatMessage[], chars: number): void {
    this.touchCache(id, messages);
    this.cachedChars += chars - (this.cacheChars.get(id) ?? 0);
    this.cacheChars.set(id, chars);
    this.evict(id);
  }

  /** 超出份数上限或字符预算时淘汰最久未用的（当前会话、keep、有排着的写入的除外） */
  private evict(keep?: string): void {
    if (!this.kernel) return;
    const id = keep;
    const pin = this.currentId();
    while (
      this.messagesCache.size > this.maxCachedConversations ||
      (this.cachedChars > this.maxCachedChars && this.messagesCache.size > 1)
    ) {
      let victim: string | undefined;
      for (const key of this.messagesCache.keys()) {
        // 有排着的写入的不淘汰：重新建会话 / 重试时要用整份消息
        if (key !== pin && key !== id && !this.pendingFor(key)) {
          victim = key;
          break;
        }
      }
      if (!victim) break;
      this.counts.set(victim, this.messagesCache.get(victim)!.length);
      this.forget(victim);
    }
  }
}

/** 第一条用户消息去掉附件后的前 PREVIEW_LEN 字（没有用户消息为空串） */
export function previewOf(messages: readonly ChatMessage[]): string {
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

function approxChars(messages: readonly ChatMessage[]): number {
  let n = 2;
  for (const m of messages) n += approxJsonLength(m) + 1;
  return n;
}
