/**
 * 待发列表（输入框上方，见 utils/pendingSends）的落盘：回复期间发出、还没交出去的消息，应用在这一轮中途重启
 * （如更新）后重新挂回这个会话 / 标签的待发列表，而不是悄悄丢掉。
 *
 * 存在 localStorage 的这一组里（Nomi 会话 `nomi:<会话 id>`，agent 标签 `tab:<标签 id>`；建组时把当时内核里的
 * 会话 id 一起记下）。每次改（入列 / 交付 / 删除 / 撤回 / Esc 合成）都同步写（localStorage 是同步的：写进就能扛
 * 进程被杀 / 崩溃 / 看门狗重启，不像内核写入那样还要排队、等 IPC 回来）：
 * - Nomi 会话的组在重建（打开、切回会话；卸载时再写一次）时写进会话元信息的 `pendingSends`
 *   （内核把元信息当不透明 JSON 存，看不到的字段原样保留；updateMeta 是一次只带元信息的 put，排在
 *   ConversationStore 的写队列里，不整份重写历史）。打开另一个窗口 / 清了 localStorage 时，元信息里那份仍是备份；
 * - agent 标签：内核只有标签（title / status 等固定字段，不收不透明的元信息），所以只在 localStorage。
 *
 * 规则：切换会话 / 标签时界面上的列表清空（#254），但存的按组分开，别的会话的不动；下次启动时标签已不再运行，
 * 存下的一律按「排队」恢复（可作为新的一轮发出）。条目带上「这一轮已经收到了」（见 storedPendingSends）：
 * 重启时内核停止如果晚了一点，这一轮可能已经拿到再跑了一段——这些按原文补成上一轮的用户消息，
 * 不当成没发出去的话（再次发送会把同一句话发两遍）。
 */
import type { IPCClient } from '../types/ipc';
import type { PendingSend } from '../utils/pendingSends';

import type { ConversationStore } from './conversationStore';

/** 存下的一条：启动后按「排队」恢复 */
export interface StoredPendingSend {
  id: string;
  text: string;
  mode: PendingSend['mode'];
  kb?: true;
  /** 这一轮启动前已经收到（见本文件开头）：补成用户消息，不再当待发 */
  sent?: true;
  /**
   * 仅内存的图片附件不写进 localStorage / 元信息，落盘这份只剩正文（或纯图占位）——
   * 只要入队时带图，写盘即标「附件缺失」，重启恢复后暂停自动发出，避免把残缺话语当原消息发送。
   */
  attachmentsMissing?: true;
  /** 仅贴图片、用户未写文字时入队：落盘正文为空，撤回时不把系统默认提示句回填到输入框 */
  imageOnly?: true;
}

/** CLI 标签的会话身份：同 id 若换了后端 / 目录 / 创建时间 / 已绑定的 CLI 会话 id，不算同一个会话 */
export interface PendingTabIdentity {
  tabId: string;
  backend: string;
  cwd: string;
  cliSessionId?: string | null;
  createdAt?: number;
}

/** 校验持久化组里记下的标签身份是否仍匹配当前标签 */
export function matchesTabIdentity(
  stored: PendingTabIdentity | undefined,
  cur: PendingTabIdentity,
): boolean {
  if (!stored) return false;
  if (stored.tabId !== cur.tabId || stored.backend !== cur.backend || stored.cwd !== cur.cwd) {
    return false;
  }
  if (
    stored.createdAt !== undefined &&
    cur.createdAt !== undefined &&
    stored.createdAt !== cur.createdAt
  ) {
    return false;
  }
  const sId = stored.cliSessionId || undefined;
  const cId = cur.cliSessionId || undefined;
  if (sId && cId && sId !== cId) return false;
  if (sId && !cId) return false;
  return true;
}

/** 写存下的待发列表的原因（决定「这一轮收到了」那份怎么并进去） */
export type PersistWhy =
  /** 建组 / 读回：以内核（或这一组）里已存的为准，不用界面上的覆盖 */
  | 'read'
  /** 入列 / 删除 / 撤回 / Esc 合成 / 会话切走之后：以界面上的为准 */
  | 'update'
  /** 交出去（成功或改排队）或队列自动发送：刚交出去的那几条多半已经随请求发到内核了 */
  | 'deliver'
  /** 卸下（关窗口 / 关标签）：以界面上的为准 */
  | 'unload'
  /** 不在了（标签关了 / 会话删了）：删掉这一组 */
  | 'clear';

/** 存下的条目上限：单条正文截断到这个长度（待发列表只是没发出去的话，不是整段文档） */
export const STORED_PENDING_MAX = 50;
export const STORED_PENDING_TEXT_MAX = 8000;

/** localStorage 键 */
export const pendingKey = (kind: 'nomi' | 'tab', id: string): string => `${kind}:${id}`;
export const PENDING_GROUP_PREFIX = 'nomi.pendingGroup:';

const pickKb = (i: PendingSend) => (i.kb ? { kb: true as const } : {});

/** 写进存下那份的（清洗过：去掉空条、截断超长正文、多余字段）；带图与附件缺失条目保留标记 */
export function storedPendingSends(
  items: readonly PendingSend[],
  sent?: readonly StoredPendingSend[],
): StoredPendingSend[] {
  const sentById = new Map<string, StoredPendingSend>();
  for (const s of sent ?? []) sentById.set(s.id, s);
  const out: StoredPendingSend[] = [];
  for (const i of items) {
    const rawText = i.text.trim();
    const missing = Boolean(i.images?.length || i.attachmentsMissing);
    const isImageOnly = Boolean(i.imageOnly || (!rawText && missing));
    if (!rawText && !missing) continue;
    const text = isImageOnly
      ? ''
      : rawText.length > STORED_PENDING_TEXT_MAX
        ? rawText.slice(0, STORED_PENDING_TEXT_MAX)
        : rawText;
    const old = sentById.get(i.id);
    out.push({
      id: i.id,
      text,
      mode: i.mode,
      ...pickKb(i),
      ...(old?.sent && old.text === text ? { sent: true as const } : {}),
      ...(missing ? { attachmentsMissing: true as const } : {}),
      ...(isImageOnly && missing ? { imageOnly: true as const } : {}),
    });
    if (out.length >= STORED_PENDING_MAX) break;
  }
  return out;
}

/** 读元信息 / 本地存下的（坏数据当没存：正常条目需有正文，attachmentsMissing 条目允许空正文） */
export function readStoredPendingSends(raw: unknown): StoredPendingSend[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredPendingSend[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || typeof r.text !== 'string') continue;
    const missing = r.attachmentsMissing === true;
    const imageOnly = r.imageOnly === true;
    if (!r.text.trim() && !missing) continue;
    out.push({
      id: r.id,
      text: r.text,
      mode: r.mode === 'steer' ? 'steer' : 'queue',
      ...(r.kb === true ? { kb: true } : {}),
      ...(r.sent === true ? { sent: true } : {}),
      ...(missing ? { attachmentsMissing: true } : {}),
      ...(imageOnly && missing ? { imageOnly: true } : {}),
    });
    if (out.length >= STORED_PENDING_MAX) break;
  }
  return out;
}

/** 读回时同样这组消息又进了列表（比如界面卸载前又写了存下的那份）：不出现第二份；仅图消息不按空正文误去重 */
export function mergeRestoredPending(
  current: readonly PendingSend[],
  stored: readonly StoredPendingSend[],
): { items: PendingSend[]; restored: PendingSend[] } {
  const ids = new Set(current.map((i) => i.id));
  const texts = new Set(
    current.filter((i) => !i.imageOnly && i.text.trim()).map((i) => i.text.trim()),
  );
  const restored: PendingSend[] = [];
  for (const s of stored) {
    const trimmed = s.text.trim();
    if (s.sent || ids.has(s.id) || (trimmed && !s.imageOnly && texts.has(trimmed))) continue;
    restored.push({ ...s, mode: 'queue' });
  }
  return { items: restored.length ? [...restored, ...current] : [...current], restored };
}

/** 这一轮收到了、但还没当成用户消息补进对话记录的那几句（重启时内核停止稍晚，这一轮接着跑了） */
export const sentPendingTexts = (stored: readonly StoredPendingSend[]): string[] =>
  stored.filter((s) => s.sent).map((s) => s.text);

/** localStorage 读写（没有就只在内存里） */
export interface Kv {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function readJson<T>(kv: Kv | undefined, key: string): T | undefined {
  try {
    const raw = kv?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(kv: Kv | undefined, key: string, value: unknown): void {
  try {
    if (value === undefined || value === null) kv?.removeItem(key);
    else kv?.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额满了 / 不可用：下一次改再试（内核元信息那份还在） */
  }
}

/** 读待发列表用的最小接口（会话在不在、它元信息里存的那份） */
type PendingMetaStore = Pick<ConversationStore, 'get'>;

/** 读 / 写待发列表的来源：会话存储（读）+ IPC（按会话回写）+ localStorage（同步的那份） */
export interface PendingSource {
  store?: PendingMetaStore;
  ipc?: Pick<IPCClient, 'savePendingSendsTo'>;
  /** 默认 window.localStorage */
  kv?: Kv;
}

/**
 * 按原因算出要写的那份：
 * - read / update / unload：以界面上的为准（条目还在就保留「这一轮收到了」的标记）；
 * - deliver：刚交出去的，这一轮多半已经随请求发到内核了——先写成不带标记的，等写「这一轮收到了」成功
 *   （done）再记上；内核一直没收到（写之前就重启了）：它们是下一轮的用户消息了，本来就不该标。
 * done 时条目已经被撤回 / 删除的不复活。
 */
function settle(
  why: PersistWhy,
  current: readonly StoredPendingSend[],
  items: readonly PendingSend[],
  done: (fresh: StoredPendingSend[]) => void,
): StoredPendingSend[] {
  // 已经在列表里的照旧（保留标记）；刚交出去的（还没在本轮记过）先不标，等确认收到
  const base = current.filter((s) => items.some((i) => i.id === s.id));
  if (why !== 'deliver') return storedPendingSends(items, base);
  // 还没在本轮记过的（这次交出去的）先不标，等确认收到（done）；其余的照旧
  const fresh = base.filter((s) => !s.sent);
  const known = base.filter((s) => s.sent);
  const out = storedPendingSends(items, known);
  if (fresh.length) done(fresh.map((s) => ({ ...s, sent: true as const })));
  return out;
}

const defaultKv = (): Kv | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

export interface PendingSendStore {
  /** 这一组在 localStorage 里的键（nomi:<会话 id> / tab:<标签 id>） */
  readonly groupKey: string;
  /** 这一组存下的（没有就空）；参数忽略（兼容按组键调用） */
  read(_key?: string): StoredPendingSend[];
  /** 改存下的那份（和现在一样就不写）；传空 = 删掉存下的。key 对不上则忽略（避免写到别的组） */
  save(key: string | undefined, items: readonly PendingSend[]): void;
  /** 同步更新 CLI 标签身份（例如首次拿回 cliSessionId），仅在已有落盘记录时回写 groupKey */
  updateTabIdentity?(identity: PendingTabIdentity): void;
  /**
   * 按原因写：localStorage 立刻写；Nomi 会话的组再写进会话元信息（同一份不写）。
   * items：界面此刻的列表（不给 = 用 save 记下的那份）。
   */
  persist(why: PersistWhy, items?: readonly PendingSend[]): Promise<void>;
}

const asPending = (s: readonly StoredPendingSend[]): PendingSend[] =>
  s.map(({ sent: _sent, ...rest }) => rest);

export type OpenPendingTarget =
  | string
  | { nomiConvoId?: string; tabIdentity?: PendingTabIdentity };

/**
 * 维护一组待发列表的那份（一次界面生命周期一个：打开会话 / 标签时建组，换到另一个时先 persist('read')）。
 * 组键见 pendingKey；首次非空写盘时记下 Nomi 会话 id 或 CLI 标签身份，清空时连同组键一并删除。
 */
export function openPendingSends(
  src: PendingSource,
  key: string,
  target?: OpenPendingTarget,
): PendingSendStore {
  const kv = src.kv ?? defaultKv();
  const groupKey = PENDING_GROUP_PREFIX + key;
  const store = src.store;
  const ipc = src.ipc;
  const nomiConvoId = typeof target === 'string' ? target : target?.nomiConvoId;
  let tabIdentity = typeof target === 'object' ? target.tabIdentity : undefined;
  const isTabKey = key.startsWith('tab:');
  const group = readJson<{ nomi?: string; tab?: PendingTabIdentity }>(kv, groupKey);
  const staleTab = Boolean(
    isTabKey && tabIdentity && group?.tab && !matchesTabIdentity(group.tab, tabIdentity),
  );
  if (staleTab && kv) {
    kv.removeItem(key);
    kv.removeItem(groupKey);
  }
  const convoId = key.startsWith('nomi:') ? (group?.nomi ?? nomiConvoId) : undefined;
  // 会话元信息里那份（内核备份）：只有 Nomi 会话、且会话还在
  const metaBase = (): StoredPendingSend[] => {
    if (!convoId || !store?.get(convoId)?.pendingSends) return [];
    return readStoredPendingSends(store.get(convoId)!.pendingSends);
  };
  const local = staleTab ? [] : readStoredPendingSends(readJson<unknown>(kv, key));
  /** 当前这份（localStorage 为准；没有就看元信息） */
  let current: StoredPendingSend[] = local.length ? local : metaBase();
  const syncKv = (items: readonly StoredPendingSend[]) => {
    if (!kv) return;
    if (!items.length) {
      writeJson(kv, key, undefined);
      writeJson(kv, groupKey, undefined);
      return;
    }
    writeJson(kv, key, items);
    const meta = isTabKey
      ? tabIdentity
        ? { tab: tabIdentity }
        : group?.tab
          ? { tab: group.tab }
          : {}
      : convoId
        ? { nomi: convoId }
        : {};
    writeJson(kv, groupKey, meta);
  };
  if (kv && !local.length && current.length) syncKv(current);
  /** 最近写进会话元信息的（同一份不重复写） */
  let metaWritten: readonly StoredPendingSend[] | undefined;
  const writeMeta = async (items: readonly StoredPendingSend[]) => {
    if (!convoId || !ipc?.savePendingSendsTo) return;
    const unsent = items.filter((i) => !i.sent);
    if (!unsent.length && !metaWritten?.length && !store?.get(convoId)?.pendingSends?.length) {
      return;
    }
    if (metaWritten && sameStored(metaWritten, items)) return;
    // 会话已被删：不再复活它
    if (store && !store.get(convoId)) return;
    metaWritten = items;
    await ipc.savePendingSendsTo(
      convoId,
      unsent.map((i) => ({ ...i })),
    );
  };
  return {
    groupKey: key,
    read: (_key?: string) => current,
    save: (id, items) => {
      if (id !== undefined && id !== key) return;
      const next = storedPendingSends(items, current);
      if (sameStored(current, next)) return;
      current = next;
    },
    updateTabIdentity: (identity) => {
      tabIdentity = identity;
      if (kv && isTabKey && (current.length > 0 || kv.getItem(key) !== null)) {
        writeJson(kv, groupKey, { tab: identity });
      }
    },
    persist: async (why, given) => {
      if (why === 'clear') {
        current = [];
        syncKv([]);
        await writeMeta([]).catch(() => undefined);
        return;
      }
      const items = given ?? asPending(current);
      const next = settle(why, current, items, (fresh) => {
        // 这一轮确实收到了：另写一次（这期间被撤回 / 删除的不复活）
        const now = storedPendingSends(items, fresh);
        current = now;
        syncKv(now);
        void writeMeta(now).catch(() => undefined);
      });
      current = next;
      syncKv(next);
      await writeMeta(next).catch(() => undefined);
    },
  };
}

const sameStored = (a: readonly StoredPendingSend[], b: readonly StoredPendingSend[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]!;
    return (
      x.id === y.id &&
      x.text === y.text &&
      x.mode === y.mode &&
      !!x.kb === !!y.kb &&
      !!x.sent === !!y.sent &&
      !!x.attachmentsMissing === !!y.attachmentsMissing &&
      !!x.imageOnly === !!y.imageOnly
    );
  });
