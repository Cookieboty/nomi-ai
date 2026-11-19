/**
 * 对话标签状态：主进程是唯一数据源（标签元数据 + CLI 标签消息），这里只做订阅与缓存。
 * 标签 'main' 为原有对话（消息走 AiChatContext）；其它标签只绑定 agent 后端。
 */
import { isBuiltinCliId } from '@nomi-ai/cli-catalog';
import { t } from '@nomi-ai/ui';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { startupBrandIntro } from '../components/BrandIntro/state';
import { confirmDialog } from '../components/ConfirmDialog';
import { ensureHarnessImages } from '../services/chatImages';
import type { RunnerPreset } from '../services/delegateClient';
import {
  MAIN_TAB_ID,
  harnessClient,
  type HarnessBackend,
  type HarnessLiveEvent,
  type HarnessTabMessage,
  type HarnessTabMeta,
  type HarnessTabsState,
} from '../services/harnessClient';
import {
  mergeRestoredPending,
  openPendingSends,
  pendingKey,
  sentPendingTexts,
  type PendingSendStore,
  type PersistWhy,
  type StoredPendingSend,
} from '../services/pendingSendsStore';
import { replyPermissionRequest } from '../services/permissionReply';
import { canSteer } from '../utils/cliCaps';
import { syncDelegateAliases } from '../utils/delegateAlias';
import {
  applyDetachedEvents,
  applyLiveEvents,
  type LiveStatus,
  type TabLive,
} from '../utils/liveState';
import {
  hasRunningTool,
  mergePending,
  mergePendingBatches,
  mergePendingKey,
  newPendingId,
  requeue,
  takeSteer,
  type PendingImage,
  type PendingMode,
  type PendingSend,
} from '../utils/pendingSends';
import { findReusableTab, isEmptyTab } from '../utils/reusableTab';
import { shareTabsState } from '../utils/shareTabsState';

/** 内存里最多缓存几个标签的消息（含当前）：其余切走后丢弃，回来时重新从主进程读取 */
const MAX_CACHED_TABS = 4;

export type { TabLive, LiveStatus };

/**
 * 不含完整标签列表的部分：后台标签的状态 / 未读变化不会让它换引用（activeTab 经结构共享，
 * 只有当前标签真的变了才换）。只关心当前标签与操作的消费者（如 App）用 useHarnessTabsCore()。
 */
export interface HarnessTabsCore {
  available: boolean;
  /** 主进程记录的当前标签 id（状态尚未加载时为 undefined） */
  activeTabId: string | undefined;
  activeTab: HarnessTabMeta | null;
  /** 当前标签是独立的 CLI 标签（非 main） */
  isCliTab: boolean;
  messages: HarnessTabMessage[];
  /** projectId：在哪个项目里开；不给 = 默认目录；preset 可选附带路由档位覆盖 */
  create: (
    backend: HarnessBackend,
    projectId?: string,
    preset?: Pick<RunnerPreset, 'source' | 'accountId' | 'model' | 'reasoningEffort'>,
  ) => Promise<void>;
  close: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  activate: (id: string) => Promise<void>;
  cycle: (dir: 1 | -1) => void;
  selectIndex: (i: number) => void;
  /** 发送；当前标签正在运行 / 排队时改为进队列（含附图，不走 steer 丢图），当前轮结束后自动发送。 */
  send: (
    text: string,
    images?: readonly PendingImage[],
    mode?: PendingMode,
    onError?: (message: string) => void,
  ) => Promise<void>;
  /**
   * 向指定标签发送（与当前激活的标签无关）：异步结果（如斜杠命令展开）要回到发起它的标签。
   * 目标运行 / 排队中时进该标签的队列（支持带图）；标签不存在 / 已关闭、是 main、或后端 / 目录与 `expect` 不符
   * （说明已被重置）时返回 false，什么都不发。
   */
  sendToTab: (
    tabId: string,
    text: string,
    expect?: { backend?: HarnessBackend; cwd?: string },
    images?: readonly PendingImage[],
    /** 标签在运行时：steer（Enter，默认，仅纯文本）插入这一轮 / queue（Ctrl+Enter 或带图）排队到这一轮结束 */
    mode?: PendingMode,
    onError?: (message: string) => void,
  ) => Promise<boolean>;
  /** 标签是否仍存在（读最新状态，不依赖渲染闭包） */
  hasTab: (tabId: string) => boolean;
  /**
   * 从当前标签的某条用户消息重新发送（重试 / 编辑）：它和之后的消息全部删除，
   * CLI 会话丢弃、剩余对话作为前文开新会话，再发 text
   */
  resendFrom: (messageId: string, text: string) => Promise<void>;
  /** 各标签运行中发出、还没交出去的消息（输入框上方的待发列表，见 utils/pendingSends） */
  queues: Record<string, PendingSend[]>;
  /** 从当前标签的待发列表删掉一条（撤回修改 / 删除） */
  removePending: (id: string) => void;
  /** Esc：停止当前标签这一轮，待发列表合成一条马上发出；列表为空时 false */
  flushPending: () => Promise<boolean>;
  cancel: () => Promise<void>;
  replyPermission: (
    requestId: string,
    allow: boolean,
    opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' },
  ) => Promise<void>;
  /** 回指定标签的权限（侧栏里的委派标签不是当前标签） */
  replyPermissionFor: (
    tabId: string,
    requestId: string,
    allow: boolean,
    opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' },
  ) => Promise<void>;
  /** 从指定标签的某条用户消息重新发送 */
  resendFromTab: (tabId: string, messageId: string, text: string) => Promise<void>;
  /** 停止指定标签这一轮（有后台子代理时先确认） */
  cancelRun: (tabId: string) => Promise<void>;
  /** 从指定标签的待发列表删掉一条 */
  removePendingFrom: (tabId: string, id: string) => void;
  /** 各标签自动发送失败的提示（正文还在待发列表最前面）；没有失败的标签为空 */
  sendFails: Record<string, PendingSendFailure>;
  /** 明确重试队首失败的那条（同样不自动重试；失败再挂回） */
  retryFailedSend: (tabId: string) => void;
  /** 队首那一条正在派发（还没被内核收下）的待发 id */
  inFlight: Record<string, string>;
  /** 关掉某个标签的自动发送失败提示 */
  clearSendError: (tabId: string) => void;
  /** 停止指定标签这一轮，待发列表合成一条马上发出 */
  flushPendingFor: (tabId: string) => Promise<boolean>;
  /** 最近使用的 agent 后端（新建标签默认） */
  lastBackend: HarnessBackend;
  /**
   * 挂回这个标签的待发列表（存在 localStorage 的 tab:<标签 id>，见 services/pendingSendsStore）：
   * 启动后调用一次，之后这个标签的每次改动（入列 / 交付 / 删除 / Esc / 发送）都写回那一组；
   * 标签已经没有（关了）或还在运行时不挂（运行中的列表是当前界面的）。返回有没有挂回（有恢复 / 接管的条目）
   */
  restorePending: (key: string) => boolean;
  /** 这个标签是不是已经挂过待发列表了 */
  pendingRestored: (tabId: string) => boolean;
}

export interface HarnessTabsValue extends HarnessTabsCore {
  /** 完整标签状态：任一标签变化都会换引用 */
  state: HarnessTabsState | null;
}

const Ctx = createContext<HarnessTabsValue | null>(null);
const CoreCtx = createContext<HarnessTabsCore | null>(null);

type LiveMap = Record<string, TabLive>;

/** 存下的那份里这条只留下正文（图片不落盘）：标成附件缺失 */
function markAttachmentsMissing(item: StoredPendingSend): StoredPendingSend {
  return { ...item, attachmentsMissing: true as const };
}

/** 自动发送失败、挂回队首的那一条：提示里带上原因，用户处理（重试 / 删除 / 手动发送）后才再发 */
export interface PendingSendFailure {
  item: PendingSend;
  message: string;
  at: number;
}

/** 两张图是不是同一张（内容以 data 为准，再比元信息；url / thumb 只是补存之后才有的） */
const sameImage = (a: PendingImage, b: PendingImage): boolean =>
  a.mime === b.mime &&
  a.data === b.data &&
  (a.id ?? '') === (b.id ?? '') &&
  (a.width ?? -1) === (b.width ?? -1) &&
  (a.height ?? -1) === (b.height ?? -1) &&
  (a.source ?? '') === (b.source ?? '');

const sameImages = (
  a: readonly PendingImage[] | undefined,
  b: readonly PendingImage[] | undefined,
): boolean => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((img, i) => sameImage(img, y[i]!));
};

/**
 * 手动发送的这条是不是就是失败的那条：正文（去首尾空白）和附图都要一样——只有正文相同、附件不同的是另一条，
 * 不能当替代提前移除（否则不同附件的消息会被吞掉）。
 */
export const sameFailedSend = (
  item: Pick<PendingSend, 'text' | 'images'>,
  text: string,
  images: readonly PendingImage[] | undefined,
): boolean => item.text.trim() === text.trim() && sameImages(item.images, images);

/**
 * 各标签的实时进度单独作为外部 store：流式期间约每帧更新一次，放进上面的 value 会让所有
 * useHarnessTabs() 的消费者（含 App）每帧重渲染。订阅方用 useHarnessLive 只取自己要的切片。
 */
interface LiveStore {
  get(): LiveMap;
  set(next: LiveMap): void;
  subscribe(listener: () => void): () => void;
}

function createLiveStore(): LiveStore {
  let live: LiveMap = {};
  const listeners = new Set<() => void>();
  return {
    get: () => live,
    set(next) {
      if (next === live) return;
      live = next;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const EMPTY_LIVE_STORE = createLiveStore();
const LiveCtx = createContext<LiveStore>(EMPTY_LIVE_STORE);
/**
 * 来源标签空闲时子代理的实时状态（用户在子任务侧栏里直接对它说话后它接着跑）：状态和逐字增量。
 * 和上面的实时进度分开放：标签空闲 / 一轮定稿时不清它
 */
const DetachedCtx = createContext<LiveStore>(createLiveStore());

interface CacheStore {
  get(): Record<string, HarnessTabMessage[]>;
  set(next: Record<string, HarnessTabMessage[]>): void;
  subscribe(listener: () => void): () => void;
}

function createCacheStore(): CacheStore {
  let cache: Record<string, HarnessTabMessage[]> = {};
  const listeners = new Set<() => void>();
  return {
    get: () => cache,
    set(next) {
      if (next === cache) return;
      cache = next;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const EMPTY_CACHE_STORE = createCacheStore();
const CacheCtx = createContext<CacheStore>(EMPTY_CACHE_STORE);

interface TabCacheApi {
  pin(id: string): void;
  unpin(id: string): void;
  seed(id: string, list: HarnessTabMessage[]): void;
}

const EMPTY_PIN: TabCacheApi = { pin() {}, unpin() {}, seed() {} };
const PinCtx = createContext<TabCacheApi>(EMPTY_PIN);
const EMPTY_MESSAGES: HarnessTabMessage[] = [];
const LAST_BACKEND_KEY = 'nomi.tabs.lastBackend';

/** 还有后台子代理 / 后台任务时，停止或关闭前确认（它们会随进程一起结束） */
async function confirmStopBackground(tab: HarnessTabMeta | undefined): Promise<boolean> {
  const n = tab?.background ?? 0;
  if (!n) return true;
  return confirmDialog({
    message: t('ui.chat-settings.background-tasks-are-still-running-and-will-be', String(n)),
    danger: true,
  });
}

export function HarnessTabsProvider({ children }: { children: React.ReactNode }) {
  const available = harnessClient.available();
  const [state, setState] = useState<HarnessTabsState | null>(null);
  const [cache, setCache] = useState<Record<string, HarnessTabMessage[]>>({});
  const [cacheStore] = useState(createCacheStore);
  useLayoutEffect(() => {
    cacheStore.set(cache);
  }, [cache, cacheStore]);
  /** 每个标签最近一次已观察到的工作目录；换目录即丢弃旧会话的渲染缓存。 */
  const cwdRef = useRef<Record<string, string>>({});
  const [live, setLive] = useState<LiveMap>({});
  // 提交后再发布给 useHarnessLive 的订阅方（同 aiChatStore）
  const [liveStore] = useState(createLiveStore);
  useLayoutEffect(() => {
    liveStore.set(live);
  }, [liveStore, live]);
  const [detached, setDetached] = useState<LiveMap>({});
  const [detachedStore] = useState(createLiveStore);
  useLayoutEffect(() => {
    detachedStore.set(detached);
  }, [detachedStore, detached]);
  const [queues, setQueues] = useState<Record<string, PendingSend[]>>({});
  const queuesRef = useRef(queues);
  /** 各标签的待发列表写回本地的那份（挂回的组，键 = 标签 id）：入列 / 交付 / 发送之后都同步 */
  const pendingStores = useRef(new Map<string, PendingSendStore>());
  const knownTabIds = useRef(new Set<string>());
  const persistTabQueue = useCallback(
    (tabId: string, list: readonly PendingSend[], why: PersistWhy = 'update') => {
      const store = pendingStores.current.get(tabId);
      if (!store) return;
      store.save(pendingKey('tab', tabId), list);
      void store.persist(why, list).catch(() => undefined);
    },
    [],
  );
  /** 已派发、已收下的那条只要不在列表里了（发出 / 删掉 / 合成）就不再算数，标签运行态不能拿它认别的条目 */
  const pruneAcks = useCallback((list: Record<string, PendingSend[]>) => {
    for (const [tabId, ack] of ackedSends.current)
      if (!list[tabId]?.some((i) => i.id === ack.id)) ackedSends.current.delete(tabId);
  }, []);
  /** 更新待发列表并同步 ref（交付判断读最新值，不等渲染）；挂回的组跟着写回 */
  const updateQueues = useCallback(
    (fn: (cur: Record<string, PendingSend[]>) => Record<string, PendingSend[]>) => {
      const prev = queuesRef.current;
      const next = fn(prev);
      queuesRef.current = next;
      setQueues(next);
      if (next === prev) return;
      pruneAcks(next);
      for (const tabId of new Set([...Object.keys(prev), ...Object.keys(next)]))
        if (pendingStores.current.has(tabId) && prev[tabId] !== next[tabId])
          persistTabQueue(tabId, next[tabId] ?? []);
    },
    [persistTabQueue],
  );
  /** 正在交付插入消息的标签 */
  const delivering = useRef(new Set<string>());
  /** 把标签待发列表里的插入消息合成一条交给这一轮；交不出去的改为排队 */
  const deliverSteer = useCallback(
    async (tabId: string) => {
      if (delivering.current.has(tabId)) return;
      const { steer: picked } = takeSteer(queuesRef.current[tabId] ?? []);
      if (!picked.length) return;
      delivering.current.add(tabId);
      const ids = new Set(picked.map((i) => i.id));
      updateQueues((cur) => ({
        ...cur,
        [tabId]: (cur[tabId] ?? []).filter((i) => !ids.has(i.id)),
      }));
      try {
        const ok = await harnessClient.steerTab(tabId, mergePending(picked));
        if (!ok) updateQueues((cur) => ({ ...cur, [tabId]: requeue(cur[tabId] ?? [], picked) }));
      } finally {
        delivering.current.delete(tabId);
        setTick((n) => n + 1);
      }
    },
    [updateQueues],
  );
  const deliverRef = useRef(deliverSteer);
  useEffect(() => {
    deliverRef.current = deliverSteer;
  }, [deliverSteer]);
  /**
   * 已派发、尚未观察到标签进入运行态的标签（值为派发时的那次尝试）：防止在状态更新前重复派发队列。
   * 同一代里只派发一次；自动发送失败并提示后，下次点发送 / 明确重试才再派发（不自动重试、不循环）。
   */
  const dispatching = useRef(new Set<string>());
  /**
   * 手动替代失败队首、等标签开始跑这次请求的标签：挂起队列自动发送（见 parkQueues）。
   * 值是派发时标签已经进入运行态的次数：之后的运行态才是这次派发自己开的。
   */
  const parkedTabs = useRef(new Map<string, number>());
  /**
   * 自动发送（排队 / 重启后挂回）失败的那一条：留在待发列表最前面，连同图片原样保留，等用户处理后
   * 再发，不自动重试、不循环。
   */
  const [sendFails, setSendFails] = useState<Record<string, PendingSendFailure>>({});
  /** 队首那一条正在派发（还没被内核收下）：待发列表照常显示，不触发下一次自动发送 */
  const [inFlight, setInFlight] = useState<Record<string, string>>({});
  /**
   * 各标签派发成功（内核收下这次请求）的那条：值为「标签开始跑 / 跑过某次请求」期间累计的轮次。
   * 标签从空闲进入运行态、轮次变了，才说明收到的是「这次派发」——别的消息先让标签跑起来（轮次没变）时，
   * 不能当成它已被收下（见 enterRunning）。
   */
  const ackedSends = useRef(new Map<string, { id: string; epoch: number }>());
  /** 标签累计进入运行态的次数（见 ackedSends） */
  const runEpoch = useRef<Record<string, number>>({});
  /** 自动发送失败后，用户再次明确发送（输入框 / 子任务 / 交付）时允许再派发一次 */
  const manualRetry = useRef(new Set<string>());
  /** 这次派发已经观察到标签进入运行态（只清一次「已派发」，失败提示由它自己的失败处理） */
  const runningAcked = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  /** effect 里读最新的失败提示（认收下的是哪条，见 enterRunning 与队列自动发送的 effect） */
  const failRef = useRef(sendFails);
  /**
   * 失败提示立刻更新（不等重渲染）：onError / 重试 / 收下都在同一个回调里紧接着读写它，
   * 按渲染时的那份判断会把刚记下 / 刚撤掉的提示看反（见 failQueuedSend / retryFailedSend）
   */
  const setFails = useCallback(
    (fn: (cur: Record<string, PendingSendFailure>) => Record<string, PendingSendFailure>) => {
      failRef.current = fn(failRef.current);
      setSendFails(failRef.current);
    },
    [],
  );
  const [lastBackend, setLastBackend] = useState<HarnessBackend>(() => {
    try {
      const v = localStorage.getItem(LAST_BACKEND_KEY);
      return v && isBuiltinCliId(v) ? v : 'claude';
    } catch {
      return 'claude';
    }
  });

  useEffect(() => {
    if (!available) {
      startupBrandIntro.taskDone('tabs');
      return;
    }
    void harnessClient
      .tabs()
      .then((s) => {
        syncDelegateAliases(s.tabs);
        setState((cur) => shareTabsState(cur, s));
      })
      .catch(() => startupBrandIntro.taskDone('tabs'));
    let flushPending: () => void = () => undefined;
    const off1 = harnessClient.onTabs((s) => {
      syncDelegateAliases(s.tabs);
      // 先落下已入队的实时事件（主进程保证它们先于本次标签状态到达），再清理已结束的标签
      flushPending();
      // 结构共享：没变的标签沿用旧对象，整份没变时 setState 拿到同一引用直接跳过
      setState((cur) => shareTabsState(cur, s));
      // 结束运行的标签清掉实时进度
      setLive((cur) => {
        let next: Record<string, TabLive> | null = null;
        for (const t of s.tabs)
          if (t.status !== 'running' && cur[t.id]) {
            next ??= { ...cur };
            delete next[t.id];
          }
        return next ?? cur;
      });
    });
    const off2 = harnessClient.onTabMessage(({ tabId, message, updated }) => {
      if (updated) {
        // 已有消息更新（来源标签空闲时子代理接着跑，轨迹追加进派出它的那条消息）：按 id 替换，不动实时进度
        setCache((cur) => {
          const list = cur[tabId];
          const i = list ? list.findIndex((m) => m.id === message.id) : -1;
          if (!list || i < 0) return cur;
          const next = list.slice();
          next[i] = message;
          return { ...cur, [tabId]: next };
        });
        return;
      }
      // 回合的定稿助手消息：和清掉实时进度放在同一次提交里。主进程先发消息、下一个 microtask
      // 才发「已空闲」的标签状态，分开提交的话中间那一帧同一段回答会渲染两份（定稿 + 流式）。
      // 后台自动回合的消息不清：用户回合可能还在进行，实时进度属于它。
      const settles = message.role === 'assistant' && message.origin !== 'background';
      // 先落下已入队的实时事件（主进程保证它们先于本条消息到达），免得之后再把进度重建出来
      if (settles) flushPending();
      setCache((cur) =>
        cur[tabId] && !cur[tabId]!.some((m) => m.id === message.id)
          ? { ...cur, [tabId]: [...cur[tabId]!, message] }
          : cur,
      );
      if (settles)
        setLive((cur) => {
          if (!cur[tabId]) return cur;
          const next = { ...cur };
          delete next[tabId];
          return next;
        });
    });
    // 实时事件按帧合批：一帧内到达的所有事件只触发一次 setState（流式文本 / 上千个工具事件不再逐条重渲染）
    const pending: HarnessLiveEvent[] = [];
    let raf = 0;
    let timer = 0;
    const flush = () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer) window.clearTimeout(timer);
      raf = 0;
      timer = 0;
      if (!pending.length) return;
      const batch = pending.splice(0, pending.length);
      const byTab = new Map<string, HarnessLiveEvent[]>();
      const offTurn = new Map<string, HarnessLiveEvent[]>();
      for (const e of batch) {
        const into = (e as { detached?: boolean }).detached ? offTurn : byTab;
        const list = into.get(e.tabId);
        if (list) list.push(e);
        else into.set(e.tabId, [e]);
      }
      if (byTab.size)
        setLive((cur) => {
          const next = { ...cur };
          for (const [tabId, evs] of byTab) next[tabId] = applyLiveEvents(cur[tabId], evs);
          return next;
        });
      if (offTurn.size)
        setDetached((cur) => {
          const next = { ...cur };
          for (const [tabId, evs] of offTurn) next[tabId] = applyDetachedEvents(cur[tabId], evs);
          return next;
        });
    };
    flushPending = flush;
    const enqueue = (e: HarnessLiveEvent) => {
      pending.push(e);
      if (raf || timer) return;
      raf = requestAnimationFrame(flush);
      // 窗口隐藏 / 最小化时 rAF 不触发：用定时器兜底，避免缓冲无限增长
      timer = window.setTimeout(flush, 100);
    };
    const handleRaw = (raw: unknown) => {
      const e = raw as HarnessLiveEvent;
      if (!e || typeof e.tabId !== 'string') return;
      enqueue(e);
      // 工具开始：这个标签等着的插入消息现在交出去（CLI 在这个工具的结果处取走）
      if (e.type === 'tool' && e.status === 'start' && !(e as { detached?: boolean }).detached)
        void deliverRef.current(e.tabId);
    };
    const off3 = harnessClient.onEvents((batch) => batch.forEach(handleRaw));
    const off4 = harnessClient.onEvent(handleRaw);
    return () => {
      off1();
      off2();
      off3();
      off4();
      pending.length = 0;
      if (raf) cancelAnimationFrame(raf);
      if (timer) window.clearTimeout(timer);
    };
  }, [available]);

  // 最新已提交的状态：给异步回调读（渲染闭包里的 activeId / status 可能已过期）
  const stateRef = useRef<HarnessTabsState | null>(null);
  useLayoutEffect(() => {
    stateRef.current = state;
  });

  /**
   * 标签不见了（关了 / 重启后主进程没恢复它）：它挂回的待发列表这份也清掉（没人会再发它）。
   * 第一次拿到标签列表时不动：那时标签列表可能还没加载全。
   */
  useEffect(() => {
    if (!state) return;
    const ids = new Set(state.tabs.map((t) => t.id));
    const known = knownTabIds.current;
    if (known.size)
      for (const [id, store] of pendingStores.current)
        if (!ids.has(id) && known.has(id)) {
          pendingStores.current.delete(id);
          void store.persist('clear').catch(() => undefined);
        }
    knownTabIds.current = ids;
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const previous = cwdRef.current;
    const changed = state.tabs
      .filter((tab) => previous[tab.id] !== undefined && previous[tab.id] !== tab.cwd)
      .map((tab) => tab.id);
    cwdRef.current = Object.fromEntries(state.tabs.map((tab) => [tab.id, tab.cwd]));
    if (!changed.length) return;
    setCache((cur) => {
      let next: Record<string, HarnessTabMessage[]> | null = null;
      for (const id of changed) {
        if (!cur[id]) continue;
        next ??= { ...cur };
        delete next[id];
      }
      return next ?? cur;
    });
  }, [state]);

  const activeId = state?.activeTabId ?? MAIN_TAB_ID;
  const activeTab = state?.tabs.find((t) => t.id === activeId) ?? null;
  const isCliTab = !!activeTab && activeTab.id !== MAIN_TAB_ID;

  // 切到 CLI 标签时拉取消息（首次）
  useEffect(() => {
    if (!available || !isCliTab || cache[activeId]) return;
    void harnessClient
      .tabMessages(activeId)
      .then((list) => setCache((cur) => ({ ...cur, [activeId]: list })))
      .catch(() => startupBrandIntro.taskDone('tabs'));
  }, [available, isCliTab, activeId, cache]);

  useEffect(() => {
    if (state && (!isCliTab || cache[activeId])) startupBrandIntro.taskDone('tabs');
  }, [state, isCliTab, activeId, cache]);

  // 缓存只留最近用过的几个标签：切走后不再占内存，回来时重新读取。
  // 侧栏钉住的标签（委派会话）不在当前标签里，也不能被这轮回收丢掉。
  const recentRef = useRef<string[]>([]);
  const pinsRef = useRef(new Set<string>());
  useEffect(() => {
    recentRef.current = [activeId, ...recentRef.current.filter((x) => x !== activeId)].slice(
      0,
      MAX_CACHED_TABS,
    );
    setCache((cur) => {
      const keep = new Set([...recentRef.current, ...pinsRef.current]);
      const keys = Object.keys(cur);
      if (keys.every((k) => keep.has(k))) return cur;
      const next: Record<string, HarnessTabMessage[]> = {};
      for (const k of keys) if (keep.has(k) && cur[k]) next[k] = cur[k]!;
      return next;
    });
  }, [activeId, cache]);

  const close = useCallback(
    async (id: string) => {
      if (id === MAIN_TAB_ID) return;
      // 关闭会拆掉 CLI 进程：还在跑的后台子代理会一起停掉，先确认（docs/development/coding-agents.md）
      if (!(await confirmStopBackground(stateRef.current?.tabs.find((x) => x.id === id)))) return;
      await harnessClient.closeTab(id);
      dispatching.current.delete(id);
      // 关标签：它存下的待发列表（重启后才挂回、还在等标签空闲的）不再需要，也不再让别的窗口发
      const store = pendingStores.current.get(id);
      pendingStores.current.delete(id);
      if (store) void store.persist('clear').catch(() => undefined);
      updateQueues((cur) => {
        if (!cur[id]) return cur;
        const next = { ...cur };
        delete next[id];
        return next;
      });
      setCache((cur) => {
        const next = { ...cur };
        delete next[id];
        return next;
      });
    },
    [updateQueues],
  );
  const rename = useCallback(async (id: string, title: string) => {
    await harnessClient.renameTab(id, title);
  }, []);
  /** 先更新当前视图，再让主进程持久化；失败时重新读取权威状态。 */
  const activate = useCallback(async (id: string) => {
    setState((cur) => {
      if (!cur || cur.activeTabId === id || !cur.tabs.some((tab) => tab.id === id)) return cur;
      return { ...cur, activeTabId: id };
    });
    try {
      await harnessClient.activateTab(id);
    } catch (error) {
      void harnessClient
        .tabs()
        .then((s) => {
          syncDelegateAliases(s.tabs);
          setState((cur) => shareTabsState(cur, s));
        })
        .catch(() => undefined);
      throw error;
    }
  }, []);
  /**
   * 新建会话：这个项目里这个端已经有还没说话的空标签就切过去，不再新开
   * （与 Nomi 主对话的 newConversation 一致，免得侧栏堆一串空会话、每个还占一个 CLI 进程）。
   */
  const create = useCallback(
    async (
      backend: HarnessBackend,
      projectId?: string,
      preset?: Pick<RunnerPreset, 'source' | 'accountId' | 'model' | 'reasoningEffort'>,
    ) => {
      const prevActive = stateRef.current?.tabs.find((t) => t.id === stateRef.current?.activeTabId);
      const reusable = findReusableTab(stateRef.current?.tabs, backend, projectId);
      const tab =
        reusable ??
        (await harnessClient.createTab(projectId ? { backend, projectId } : { backend }));
      const shouldClosePrevEmpty =
        !reusable &&
        !!prevActive &&
        prevActive.id !== MAIN_TAB_ID &&
        prevActive.id !== tab.id &&
        isEmptyTab(prevActive) &&
        !(prevActive.carriedMessages ?? 0) &&
        !prevActive.finished &&
        !prevActive.lastError &&
        !prevActive.subagentOf &&
        !(cacheStore.get()[prevActive.id]?.length ?? 0) &&
        !(queuesRef.current[prevActive.id]?.length ?? 0);
      if (shouldClosePrevEmpty) {
        void harnessClient.closeTab(prevActive.id).catch(() => undefined);
      }
      if (preset) {
        await harnessClient.setTabSource(
          tab.id,
          preset.source,
          preset.model ?? undefined,
          preset.source === 'official' ? (preset.accountId ?? null) : null,
        );
        if (preset.reasoningEffort) {
          await harnessClient.setTabEffort(tab.id, preset.reasoningEffort).catch(() => undefined);
        }
      }
      setCache((cur) => ({ ...cur, [tab.id]: cur[tab.id] ?? [] }));
      setLastBackend(backend);
      try {
        localStorage.setItem(LAST_BACKEND_KEY, backend);
      } catch {
        /* ignore */
      }
      // 复用的是已经存在的空标签：它多半不是当前标签，切过去
      if (reusable) await activate(tab.id);
    },
    [activate, cacheStore],
  );
  // 只在标签增删 / 重排时换引用：cycle / selectIndex 不随后台标签的状态广播变化
  const idsKey = state?.tabs.map((t) => t.id).join('\u0000') ?? '';
  const ids = useMemo(() => (idsKey ? idsKey.split('\u0000') : []), [idsKey]);
  const cycle = useCallback(
    (dir: 1 | -1) => {
      if (ids.length < 2) return;
      const i = ids.indexOf(activeId);
      void activate(ids[(i + dir + ids.length) % ids.length]!);
    },
    [ids, activeId, activate],
  );
  const selectIndex = useCallback(
    (i: number) => {
      const id = i >= 8 ? ids[ids.length - 1] : ids[i];
      if (id) void activate(id);
    },
    [ids, activate],
  );
  const dispatchSend = useCallback(
    async (
      tabId: string,
      text: string,
      images?: readonly PendingImage[],
    ): Promise<string | null> => {
      setLive((cur) => ({ ...cur, [tabId]: { text: '', startedAt: Date.now() } }));
      try {
        const harnessImages = images?.length ? await ensureHarnessImages(images) : undefined;
        // 结果经 tab-message 事件进入缓存；发送前预检等错误在此捕获并立刻清理占位 live 状态
        await harnessClient.sendTab(tabId, text, harnessImages);
        return null;
      } catch (err) {
        setLive((cur) => {
          if (!(tabId in cur)) return cur;
          const next = { ...cur };
          delete next[tabId];
          return next;
        });
        return err instanceof Error ? err.message : String(err);
      }
    },
    [],
  );
  /** 标签的自动发送失败提示（可见失败：正文还没发出去，排在待发列表最前面） */
  const clearSendError = useCallback(
    (tabId: string) => {
      manualRetry.current.delete(tabId);
      setFails((cur) => {
        if (!(tabId in cur)) return cur;
        const next = { ...cur };
        delete next[tabId];
        return next;
      });
    },
    [setFails],
  );
  const markSendError = useCallback(
    (tabId: string, item: PendingSend, message: string) => {
      setFails((cur) => ({ ...cur, [tabId]: { item, message, at: Date.now() } }));
    },
    [setFails],
  );
  /** 叫醒队列自动发送（状态 / 列表 / 失败提示都没变时 effect 不会自己重跑） */
  const resumeQueues = useCallback(() => setTick((n) => n + 1), []);
  /**
   * 派发已确认（回执成功）：记下「收下的是这条」。标签开始跑的那次运行态若还属这条标签之前空闲时的轮次
   * （同一个标签上先手发了别的消息），不能当成它——见 enterRunning。
   */
  const ackDispatch = useCallback((tabId: string, id: string) => {
    ackedSends.current.set(tabId, { id, epoch: runEpoch.current[tabId] ?? 0 });
  }, []);
  /**
   * 手动重发了失败队首那条、派发已成功：标签要等这次请求让它进入运行态（内核收下）、这一轮跑完再接着发后面的。
   * 去掉队首之后列表里只剩后面那几条，此刻不能把它们当成队首发出去（会跑到刚补发的那条前面）：先挂起，
   * 等标签开始跑这次请求再接着自动发送（见队列自动发送的 effect）。
   */
  const parkQueues = useCallback((tabId: string) => {
    parkedTabs.current.set(tabId, runEpoch.current[tabId] ?? 0);
  }, []);
  /**
   * 自动发送（排队 / 挂回的消息）队首失败：整条放回列表最前面，正文与图片都保留。
   * 带图的那条在落盘的队列里只留得下正文（图按现有策略不落盘）：同步标成「附件缺失」，重启后提示重新附图、
   * 不把不完整的正文当成原消息自动发出。
   */
  const failQueuedSend = useCallback(
    (tabId: string, item: PendingSend, message: string) => {
      updateQueues((cur) => {
        const q = cur[tabId] ?? [];
        if (q.some((i) => i.id === item.id)) return cur;
        return { ...cur, [tabId]: [item, ...q] };
      });
      const store = pendingStores.current.get(tabId);
      if (store && item.images?.length) {
        // 带图的那一条落盘时只留得下正文：标「附件缺失」（keepMissing 认传进来的条目上也认已存下的那份），
        // 立刻写稳 localStorage（persist('update')）——重启后 restorePending 只从这里看得见这个标记。
        // 只标真正失败的这一条：后面排着的别条（含要下轮的纯文字）不许挂上这个标记
        store.save(
          pendingKey('tab', tabId),
          store.read().map((s) => (s.id === item.id ? markAttachmentsMissing(s) : s)),
        );
        void store.persist('update', queuesRef.current[tabId] ?? [item]).catch(() => undefined);
      }
      markSendError(tabId, item, message);
    },
    [updateQueues, markSendError],
  );
  const sendToTab = useCallback(
    async (
      tabId: string,
      text: string,
      expect?: { backend?: HarnessBackend; cwd?: string },
      images?: readonly PendingImage[],
      mode: PendingMode = 'steer',
      onError?: (message: string) => void,
    ): Promise<boolean> => {
      if (tabId === MAIN_TAB_ID) return false;
      const tab = stateRef.current?.tabs.find((t) => t.id === tabId);
      if (!tab) return false;
      if (expect?.backend !== undefined && tab.backend !== expect.backend) return false;
      if (expect?.cwd !== undefined && tab.cwd !== expect.cwd) return false;
      if (tab.status === 'running' || tab.status === 'queued' || dispatching.current.has(tabId)) {
        const hasImages = !!images?.length;
        // 队首有自动发送失败的条目 / 正在自动发送时，新消息不能插入这一轮：按原顺序排到队尾，
        // 否则会被自动发送先于失败的队首发出（乱序）
        const waiting =
          !!sendFails[tabId] || !!inFlight[tabId] || (queuesRef.current[tabId]?.length ?? 0) > 0;
        // 后端不能中途插入（Gemini / dsh）或带有图片附件（避免纯文本 steer 丢图）：一律排队
        const m: PendingMode =
          !hasImages && mode === 'steer' && !waiting && canSteer(tab.backend) ? 'steer' : 'queue';
        const item: PendingSend = {
          id: newPendingId(),
          text,
          mode: m,
          ...(hasImages ? { images: [...images] } : {}),
        };
        updateQueues((cur) => ({ ...cur, [tabId]: [...(cur[tabId] ?? []), item] }));
        // 正好有工具在跑：现在交出去，这个工具的结果回给模型时一起带上
        if (m === 'steer' && hasRunningTool(liveStore.get()[tabId]?.trace))
          void deliverSteer(tabId);
        return true;
      }
      // 发的是上次失败的那条（正文与附图都一样）且还排在队列里：这次派发即替代它。
      // 替代要等派发成功确认之后才做（见下）：这次再失败时原条目仍留在队首、失败提示照旧可见，不能先删。
      const failed = sendFails[tabId]?.item;
      // 同一条：正文（去首尾空白）与附图都要一样、还排在队列里。只比正文会把附件不同的消息当成它
      const entry =
        failed && sameFailedSend(failed, text, images)
          ? (queuesRef.current[tabId] ?? []).find((i) => i.id === failed.id)
          : undefined;
      // 判定时的那一份（图片不可变）：commit 里用它从列表里移除 / 挂回，别在派发期间被改掉的列表上判断
      const replaceId = entry?.id;
      // 回执之后立刻提交（不在早退路径之前就 return，失败也要提交）：成功才移除原失败项、撤掉提示；
      // 失败时原条目留在 / 回到队首并重新记上原因
      const commit = (err: string | null): void => {
        if (err && replaceId) {
          // 手动重发又失败：原条目回到队首（已经在那就不重复），失败提示重新记上——原因不丢，不静默吞掉。
          // 派发前为防成功后抢发后面几条而挂起的，这次没成功，要解除，否则提示清掉后自动发送也被挡住。
          parkedTabs.current.delete(tabId);
          failQueuedSend(tabId, entry, err);
        } else if (!err && replaceId) {
          // 成功确认后才移除原失败项并撤掉失败提示；队列里那些原条目只管新的派发结果（或用户的删改）
          updateQueues((cur) => ({
            ...cur,
            [tabId]: (cur[tabId] ?? []).filter((i) => i.id !== replaceId),
          }));
          clearSendError(tabId);
        } else if (err && !queuesRef.current[tabId]?.length) {
          // 没走队列 / 没替代：这次派发失败不归队列失败管，清掉的是过时的失败提示
          clearSendError(tabId);
        }
        setTick((n) => n + 1);
      };
      // 替代失败的那条：派发之前就先挂起后面几条（见 parkQueues）——成功确认时列表已经变了、状态还没变，
      // 队列自动发送的 effect 会先跑起来把后面那条当队首发出去。只有替代才挂起（用户必须先有过失败动作），
      // 再次失败时原条目回到队首（失败提示挡着）；成功时由标签开始跑这次请求解除挂起
      if (replaceId) parkQueues(tabId);
      dispatching.current.add(tabId);
      let sendErr: string | null;
      try {
        sendErr = await dispatchSend(tabId, text, images);
      } catch (err) {
        sendErr = err instanceof Error ? err.message : String(err);
      } finally {
        dispatching.current.delete(tabId);
      }
      commit(sendErr);
      if (sendErr) {
        onError?.(sendErr);
        return false;
      }
      return true;
    },
    [
      dispatchSend,
      updateQueues,
      deliverSteer,
      liveStore,
      sendFails,
      clearSendError,
      failQueuedSend,
      parkQueues,
      inFlight,
    ],
  );
  /** 明确重试自动发送失败的那条（用户点「重试」）：按原顺序重新走一次 dispatching */
  const retryFailedSend = useCallback(
    (tabId: string) => {
      const failed = sendFails[tabId];
      if (!failed) return;
      // 已经不在列表里（被删 / 撤回）：只撤掉提示
      if (!(queuesRef.current[tabId] ?? []).some((i) => i.id === failed.item.id)) {
        clearSendError(tabId);
        return;
      }
      clearSendError(tabId);
      // 上一次自动派发早就有回执了（失败提示就是它的结果）：这一次派发不再算数，清掉「已派发」的标记
      dispatching.current.delete(tabId);
      // 用户明确重试：之前手动替代失败留下的挂起也要解开，否则自动发送不会再跑，失败提示也就回不来
      parkedTabs.current.delete(tabId);
      // 标签空闲时（失败之后停下来了）就是要它再派发一次；正在跑 / 排队时等它停下来，由上面的 effect 清标记再发
      if (stateRef.current?.tabs.find((t) => t.id === tabId)?.status === 'idle')
        manualRetry.current.add(tabId);
      setTick((n) => n + 1);
    },
    [sendFails, clearSendError],
  );
  const hasTab = useCallback(
    (tabId: string) => !!stateRef.current?.tabs.some((t) => t.id === tabId),
    [],
  );
  const send = useCallback(
    async (
      text: string,
      images?: readonly PendingImage[],
      mode?: PendingMode,
      onError?: (message: string) => void,
    ) => {
      if (!isCliTab) return;
      await sendToTab(activeId, text, undefined, images, mode, onError);
    },
    [isCliTab, activeId, sendToTab],
  );
  const resendFromTab = useCallback(
    async (tabId: string, messageId: string, text: string) => {
      if (tabId === MAIN_TAB_ID) return;
      if (!stateRef.current?.tabs.some((t) => t.id === tabId)) return;
      const kept = await harnessClient.rewindTab(tabId, messageId);
      setCache((cur) => ({ ...cur, [tabId]: kept }));
      await sendToTab(tabId, text);
    },
    [sendToTab],
  );
  const resendFrom = useCallback(
    async (messageId: string, text: string) => {
      if (!isCliTab) return;
      await resendFromTab(activeId, messageId, text);
    },
    [isCliTab, activeId, resendFromTab],
  );
  const removePendingFrom = useCallback(
    (tabId: string, id: string) =>
      updateQueues((cur) => {
        const q = cur[tabId];
        if (!q?.some((i) => i.id === id)) return cur;
        return { ...cur, [tabId]: q.filter((i) => i.id !== id) };
      }),
    [updateQueues],
  );
  const removePending = useCallback(
    (id: string) => removePendingFrom(activeId, id),
    [activeId, removePendingFrom],
  );
  /**
   * 挂回这个标签的待发列表（存在本地的 tab:<标签 id>，见 services/pendingSendsStore）：应用在回复中途重启
   * （如更新）后，重启前还没交出去的消息回来了（按「排队」），标签一开始不在运行态，队列自动发送会把它们发出去。
   * 标签已经不在了 / 已挂过 / 还在运行时不挂。返回有没有挂上的条目。
   */
  const restorePending = useCallback(
    (key: string) => {
      const tabId = key.startsWith('tab:') ? key.slice(4) : '';
      if (!tabId || tabId === MAIN_TAB_ID || pendingStores.current.has(tabId)) return false;
      const tab = stateRef.current?.tabs.find((x) => x.id === tabId);
      if (!tab || stateRef.current?.activeTabId !== tabId) return false;
      const store = openPendingSends({}, key);
      const stored = store.read(key);
      // 重启前自动发送失败、还带着图的那条：图片不落盘，这里只剩正文——恢复后不自动发出，提示重新附图
      const missing = stored.filter((s) => s.attachmentsMissing && !s.sent);
      // 自动发送失败、带图的那条不落图：这里的提示理由只在本轮生效（用户重新附上后再发）
      if (missing.length) {
        const item: PendingSend = { id: missing[0]!.id, text: missing[0]!.text, mode: 'queue' };
        setSendFails((cur) => ({
          ...cur,
          [tabId]: {
            item,
            message: t('ui.session-workspace.pending-send-attachments-missing'),
            at: Date.now(),
          },
        }));
      }
      // 这一轮已经收到了（重启时内核停得晚了一点，这一轮接着跑）：不是没发出去的话
      const sent = new Set(sentPendingTexts(stored));
      const alive = stored.filter((s) => !sent.has(s.text.trim()));
      if (!alive.length) {
        // 没有要挂回的：下次启动也不用再挂（这份组键留着，重启后元信息照样能写回去）
        if (stored.length) store.save(key, []);
        return false;
      }
      pendingStores.current.set(tabId, store);
      store.save(key, alive);
      if (tab.status === 'running' || tab.status === 'queued')
        // 还在运行（重启后主进程恢复了这一轮）：先不塞进列表，等它结束时再说
        return false;
      const { items, restored } = mergeRestoredPending(queuesRef.current[tabId] ?? [], alive);
      updateQueues((cur) => ({ ...cur, [tabId]: items }));
      if (stored.length !== alive.length) persistTabQueue(tabId, items);
      return restored.length > 0;
    },
    [updateQueues, persistTabQueue],
  );
  const pendingRestored = useCallback((tabId: string) => pendingStores.current.has(tabId), []);
  // 重启时标签还在跑：先记下存下的列表，等它结束再挂回（现在挂上会被自动发送打断这一轮）
  useEffect(() => {
    const tabs = state?.tabs ?? [];
    for (const tab of tabs) {
      if (tab.status === 'running' || tab.status === 'queued') continue;
      const store = pendingStores.current.get(tab.id);
      if (!store) continue;
      const stored = store.read();
      const { items, restored } = mergeRestoredPending(queuesRef.current[tab.id] ?? [], stored);
      if (restored.length) updateQueues((cur) => ({ ...cur, [tab.id]: items }));
    }
  }, [state, updateQueues]);
  const flushPendingFor = useCallback(
    async (tabId: string) => {
      const all = queuesRef.current[tabId] ?? [];
      if (tabId === MAIN_TAB_ID || !all.length) return false;
      if (!stateRef.current?.tabs.some((t) => t.id === tabId)) return false;
      // 合成按后端图片上限分批排在最前：停下来后队列自动发送马上发出。
      // 用户明确「停止并马上发送」：原来队首的失败提示不再适用（条目已合并成新的），
      // 先前挂起也要解开，否则停下来回到空闲时自动发送被挡住，合并后的那条发不出去。
      clearSendError(tabId);
      parkedTabs.current.delete(tabId);
      updateQueues((cur) => ({
        ...cur,
        [tabId]: mergePendingBatches(all, 8),
      }));
      await harnessClient.cancelTab(tabId);
      return true;
    },
    [updateQueues, clearSendError],
  );
  const flushPending = useCallback(async () => {
    if (!isCliTab) return false;
    return flushPendingFor(activeId);
  }, [isCliTab, activeId, flushPendingFor]);

  /**
   * 标签进入运行态（内核收下了这次请求）：只有派发成功的那条「自己」让标签跑起来才算收下——
   * 之前这条标签在空闲时就跑过别的请求（另一个轮次），说明跑起来的是别的消息（刚在同一个标签上手发的
   * 别的一句 / 正文相同但附件不同的那条），失败队首既没被收下也不能解除提示：它仍在队首等用户处理。
   * 返回这次运行态是不是收下了队列派发的那条。
   */
  const enterRunning = useCallback(
    (tabId: string): boolean => {
      runEpoch.current[tabId] = (runEpoch.current[tabId] ?? 0) + 1;
      const ack = ackedSends.current.get(tabId);
      const fail = failRef.current[tabId];
      // 失败提示还是这条的（队首是否还是它由成功分支按 id 移除时再判：Esc 合成后原条目已并入一条）
      if (!ack || !fail || fail.item.id !== ack.id) return false;
      ackedSends.current.delete(tabId);
      clearSendError(tabId);
      return true;
    },
    [clearSendError],
  );
  // 用户明确重试（「重试」/ 手动发送）后，先把「上一次自动派发还没收尾」这个标记清掉：之后状态再变化时
  // 队列自动发送能重新派发队首（失败仍会挂回并提示，不会自动重试）
  useEffect(() => {
    // 按 ref 里最新的状态判断：这次 effect 是 tick 叫醒的，state 还是渲染时那份，会把「正在跑」看成空闲
    for (const tab of stateRef.current?.tabs ?? []) {
      if (!manualRetry.current.has(tab.id)) continue;
      manualRetry.current.delete(tab.id);
      if (tab.status === 'running' || tab.status === 'queued') continue;
      dispatching.current.delete(tab.id);
    }
  }, [state, sendFails, queues, tick]);
  /** 队列自动发送一条（标签空闲）：成功才从列表移除；失败整条挂回队首并给出可见原因（不自动重试） */
  const autoSend = useCallback(
    (tabId: string, next: PendingSend) => {
      // 锁同步打上（不等 inFlight 的渲染，也不等回执）：同一轮里 effect 再跑（流式 / StrictMode 的重复执行）
      // 也派发不了第二次；只有这一次的回执（成功 / 失败）才解除它
      dispatching.current.add(tabId);
      setInFlight((cur) => ({ ...cur, [tabId]: next.id }));
      const done = () => {
        setInFlight((cur) => {
          if (cur[tabId] !== next.id) return cur;
          const copy = { ...cur };
          delete copy[tabId];
          return copy;
        });
        dispatching.current.delete(tabId);
        setTick((n) => n + 1);
      };
      void dispatchSend(tabId, next.text, next.images)
        .then((err) => {
          // 回执晚到期间这条可能已被删 / 撤 / Esc 合成：按 id 移除，别动那之后的列表
          if (err) {
            // 每次自动派发前都先挡住了「已派发 / 有失败提示」，所以这里的失败只有这一次自己能看到：
            // 整条（正文 + 图片）挂回队首并提示，不自动重试（手动发送 / 重试会解除 dispatching 再派发一次）
            failQueuedSend(tabId, next, err);
            return;
          }
          const already = !(queuesRef.current[tabId] ?? []).some((i) => i.id === next.id);
          updateQueues((cur) => ({
            ...cur,
            [tabId]: (cur[tabId] ?? []).filter((i) => i.id !== next.id),
          }));
          // 发出去、这一轮收到了（挂回的组跟着改：见 pendingSendsStore.settle，重启时不再次发出）
          if (!already) persistTabQueue(tabId, queuesRef.current[tabId] ?? [], 'deliver');
          ackDispatch(tabId, next.id);
        })
        .catch((err: unknown) => failQueuedSend(tabId, next, String(err)))
        .finally(done);
    },
    [dispatchSend, updateQueues, persistTabQueue, failQueuedSend, ackDispatch],
  );
  // 队列自动发送：标签空闲且队列非空时发出队首；已派发的标签要等它进入运行态后再继续。
  // 队首发出后先留在列表里（标成「正在发送」），内核收下（标签进入运行态）才算交付——以前先删再派发，
  // 派发在图片导入 / 预检 / 来源帧被换掉时返回错误就整条消失（正文和图片都没了）。
  useEffect(() => {
    if (!state) return;
    for (const tab of state.tabs) {
      if (tab.status === 'running' || tab.status === 'queued') {
        // 每次运行态只处理一次（还在跑、调用方又改了别的状态时不会再广播一次）
        if (runningAcked.current.has(tab.id)) continue;
        runningAcked.current.add(tab.id);
        // 内核收下了这次派发（且是自己派发的那条）：清「已派发」，那条的失败提示也就不成立了。
        // 这是别的消息 / 手发的那条开的轮次：失败队首原样留着，不解除提示、不自动重试
        if (dispatching.current.delete(tab.id)) manualRetry.current.delete(tab.id);
        // 手动替代的那条被收下（enterRunning）→ 接着发后面的；替代时标签已在运行（「别的一句」开的轮次）
        // 的那次不算数，等同一次运行态再看（见 parkQueues）
        const acked = enterRunning(tab.id);
        const parkedEpoch = parkedTabs.current.get(tab.id);
        if (parkedEpoch !== undefined && (acked || (runEpoch.current[tab.id] ?? 0) > parkedEpoch))
          parkedTabs.current.delete(tab.id);
        continue;
      }
      // 回到空闲：下一轮在这个标签上发的消息再跑起来，要重新认是不是队列派发的那条
      runningAcked.current.delete(tab.id);
      const q = queues[tab.id];
      // 派发还在途中（等到回执或失败 / 手动重发失败队首）就不动队首：期间标签先回到空闲也不能重发同一条
      if (!q?.length || dispatching.current.has(tab.id) || inFlight[tab.id]) continue;
      // 挂起的：等它开始跑这次请求（上面的运行态分支收下后才清掉标记接着发）
      if (parkedTabs.current.has(tab.id)) continue;
      if (delivering.current.has(tab.id)) continue;
      // 自动发送失败：留在队首等用户处理（重试 / 删除 / 手动发送），不自动再发。
      // 读 ref：重试刚清掉提示、渲染还没跟上时，这次开了新一轮就要派发（提示还在 register 里没提交的话会卡住）
      if (failRef.current[tab.id]) continue;
      void autoSend(tab.id, q[0]!);
    }
  }, [state, queues, inFlight, sendFails, autoSend, enterRunning]);
  const cancelRun = useCallback(async (tabId: string) => {
    if (tabId === MAIN_TAB_ID) return;
    const tab = stateRef.current?.tabs.find((x) => x.id === tabId);
    if (!tab) return;
    if (!(await confirmStopBackground(tab))) return;
    await harnessClient.cancelTab(tabId);
  }, []);
  const cancel = useCallback(async () => {
    if (!isCliTab) return;
    await cancelRun(activeId);
  }, [isCliTab, activeId, cancelRun]);
  const replyPermissionFor = useCallback(
    async (
      tabId: string,
      requestId: string,
      allow: boolean,
      opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' },
    ) => {
      if (tabId === MAIN_TAB_ID) return;
      const tab = stateRef.current?.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const taskId = tab.delegation?.taskId;
      // 持续任务的委派先经任务回应，失败再回标签（与主列同一条 replyPermissionRequest）
      const ok = await replyPermissionRequest(tabId, requestId, allow, {
        ...(opts?.approvePlan ? { approvePlan: opts.approvePlan } : {}),
        ...(taskId ? { taskId } : {}),
      }).catch(() => false);
      if (!ok) return;
      setLive((cur) => {
        const prev = cur[tabId];
        if (!prev?.permissions?.some((p) => p.id === requestId)) return cur;
        const rest = prev.permissions.filter((p) => p.id !== requestId);
        const { permissions: _p, ...others } = prev;
        return { ...cur, [tabId]: rest.length ? { ...others, permissions: rest } : others };
      });
    },
    [],
  );
  const replyPermission = useCallback(
    async (
      requestId: string,
      allow: boolean,
      opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' },
    ) => {
      if (!isCliTab) return;
      await replyPermissionFor(activeId, requestId, allow, opts);
    },
    [isCliTab, activeId, replyPermissionFor],
  );

  const messages = (isCliTab && cache[activeId]) || EMPTY_MESSAGES;
  const stateActiveTabId = state?.activeTabId;
  const core = useMemo<HarnessTabsCore>(
    () => ({
      available,
      activeTabId: stateActiveTabId,
      activeTab,
      isCliTab,
      messages,
      create,
      close,
      rename,
      activate,
      cycle,
      selectIndex,
      send,
      sendToTab,
      hasTab,
      resendFrom,
      queues,
      removePending,
      flushPending,
      cancel,
      replyPermission,
      replyPermissionFor,
      resendFromTab,
      cancelRun,
      removePendingFrom,
      flushPendingFor,
      lastBackend,
      restorePending,
      pendingRestored,
      sendFails,
      retryFailedSend,
      inFlight,
      clearSendError,
    }),
    [
      available,
      stateActiveTabId,
      activeTab,
      isCliTab,
      messages,
      create,
      close,
      rename,
      activate,
      cycle,
      selectIndex,
      send,
      sendToTab,
      hasTab,
      resendFrom,
      queues,
      removePending,
      flushPending,
      cancel,
      replyPermission,
      replyPermissionFor,
      resendFromTab,
      cancelRun,
      removePendingFrom,
      flushPendingFor,
      lastBackend,
      restorePending,
      pendingRestored,
      sendFails,
      retryFailedSend,
      inFlight,
      clearSendError,
    ],
  );
  const value = useMemo<HarnessTabsValue>(() => ({ ...core, state }), [core, state]);
  const tabCacheApi = useMemo<TabCacheApi>(
    () => ({
      pin(id: string) {
        pinsRef.current.add(id);
      },
      unpin(id: string) {
        pinsRef.current.delete(id);
      },
      seed(id: string, list: HarnessTabMessage[]) {
        setCache((cur) => (cur[id] ? cur : { ...cur, [id]: list }));
      },
    }),
    [],
  );
  return (
    <Ctx.Provider value={value}>
      <CoreCtx.Provider value={core}>
        <LiveCtx.Provider value={liveStore}>
          <DetachedCtx.Provider value={detachedStore}>
            <CacheCtx.Provider value={cacheStore}>
              <PinCtx.Provider value={tabCacheApi}>{children}</PinCtx.Provider>
            </CacheCtx.Provider>
          </DetachedCtx.Provider>
        </LiveCtx.Provider>
      </CoreCtx.Provider>
    </Ctx.Provider>
  );
}

const EMPTY: HarnessTabsValue = {
  available: false,
  state: null,
  activeTabId: undefined,
  activeTab: null,
  isCliTab: false,
  messages: [],
  create: async () => undefined,
  close: async () => undefined,
  rename: async () => undefined,
  activate: async () => undefined,
  cycle: () => undefined,
  selectIndex: () => undefined,
  send: async () => undefined,
  sendToTab: async () => false,
  hasTab: () => false,
  resendFrom: async () => undefined,
  queues: {},
  removePending: () => undefined,
  flushPending: async () => false,
  cancel: async () => undefined,
  replyPermission: async () => undefined,
  replyPermissionFor: async () => undefined,
  resendFromTab: async () => undefined,
  cancelRun: async () => undefined,
  removePendingFrom: () => undefined,
  flushPendingFor: async () => false,
  lastBackend: 'claude',
  restorePending: () => false,
  pendingRestored: () => false,
  sendFails: {},
  retryFailedSend: () => undefined,
  inFlight: {},
  clearSendError: () => undefined,
};

/** 完整的标签上下文（含 state）：任一标签变化都会重渲染，只给需要标签列表的组件用 */
export function useHarnessTabs(): HarnessTabsValue {
  return useContext(Ctx) ?? EMPTY;
}

/** 不含标签列表：只在当前标签 / 队列 / 当前消息 / 操作变化时重渲染 */
export function useHarnessTabsCore(): HarnessTabsCore {
  return useContext(CoreCtx) ?? EMPTY;
}

/**
 * 订阅实时进度的一个切片：只有选出的值变了才重渲染。各标签的进度对象只在它自己有新事件时换引用，
 * 选择器应返回其中的对象 / 原始值（不要每次新建对象，否则每帧都算变化）。
 */
export function useHarnessLive<T>(selector: (live: LiveMap) => T): T {
  const store = useContext(LiveCtx);
  const get = () => selector(store.get());
  return useSyncExternalStore(store.subscribe, get, get);
}

/** 来源标签空闲时子代理的实时状态（见 DetachedCtx）；用法同 useHarnessLive */
export function useHarnessDetached<T>(selector: (live: LiveMap) => T): T {
  const store = useContext(DetachedCtx);
  const get = () => selector(store.get());
  return useSyncExternalStore(store.subscribe, get, get);
}

/**
 * 某个标签的消息（不必是当前标签）。侧栏打开委派会话时钉住这份缓存，
 * 流式定稿经 tab-message 写进来，主列仍停在来源对话。
 */
export function useHarnessTabMessages(tabId: string | null): readonly HarnessTabMessage[] {
  const store = useContext(CacheCtx);
  const pins = useContext(PinCtx);
  useEffect(() => {
    if (!tabId) return;
    pins.pin(tabId);
    return () => pins.unpin(tabId);
  }, [tabId, pins]);
  useEffect(() => {
    if (!tabId || !harnessClient.available() || store.get()[tabId]) return;
    let alive = true;
    void harnessClient
      .tabMessages(tabId)
      .then((list) => {
        if (alive) pins.seed(tabId, list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [tabId, store, pins]);
  return useSyncExternalStore(
    store.subscribe,
    () => (tabId ? store.get()[tabId] : undefined) ?? EMPTY_MESSAGES,
    () => EMPTY_MESSAGES,
  );
}
