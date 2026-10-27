/**
 * 对话标签状态：主进程是唯一数据源（标签元数据 + CLI 标签消息），这里只做订阅与缓存。
 * 标签 'main' 为原有对话（消息走 AiChatContext）；其它标签只绑定编程助手后端。
 */
import { isBuiltinCliId } from '@nomi-ai/cli-plugins';
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

import {
  MAIN_TAB_ID,
  harnessClient,
  type HarnessBackend,
  type HarnessImageInput,
  type HarnessLiveEvent,
  type HarnessTabMessage,
  type HarnessTabMeta,
  type HarnessTabsState,
} from '../services/harnessClient';
import { applyLiveEvents, type LiveStatus, type TabLive } from '../utils/liveState';
import { shareTabsState } from '../utils/shareTabsState';

/** 内存里最多缓存几个标签的消息（含当前）：其余切走后丢弃，回来时重新从主进程读取 */
const MAX_CACHED_TABS = 4;

export type { TabLive, LiveStatus };

/**
 * 不含完整标签列表的部分：后台标签的状态 / 未读变化不会让它换引用（activeTab 经结构共享，
 * 只有当前标签真的变了才换）。只关心当前标签与操作的消费者（如 App）用 useHarnessTabsCore()。
 */
interface HarnessTabsCore {
  available: boolean;
  /** 主进程记录的当前标签 id（状态尚未加载时为 undefined） */
  activeTabId: string | undefined;
  activeTab: HarnessTabMeta | null;
  /** 当前标签是独立的 CLI 标签（非 main） */
  isCliTab: boolean;
  messages: HarnessTabMessage[];
  create: (backend: HarnessBackend, cwd?: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  activate: (id: string) => Promise<void>;
  cycle: (dir: 1 | -1) => void;
  selectIndex: (i: number) => void;
  /** 发送；当前标签正在运行 / 排队时改为进队列，当前轮结束后自动发送。附图仅空闲直发（排队不带图）。 */
  send: (text: string, images?: HarnessImageInput[]) => Promise<void>;
  /**
   * 向指定标签发送（与当前激活的标签无关）：异步结果（如斜杠命令展开）要回到发起它的标签。
   * 目标运行 / 排队中时进该标签的队列；标签不存在 / 已关闭、是 main、或后端 / 目录与 `expect` 不符
   * （说明已被重置）时返回 false，什么都不发。
   */
  sendToTab: (
    tabId: string,
    text: string,
    expect?: { backend?: HarnessBackend; cwd?: string },
    images?: HarnessImageInput[],
  ) => Promise<boolean>;
  /** 标签是否仍存在（读最新状态，不依赖渲染闭包） */
  hasTab: (tabId: string) => boolean;
  /** 各标签排队中的待发消息 */
  queues: Record<string, string[]>;
  removeQueued: (index: number) => void;
  cancel: () => Promise<void>;
  replyPermission: (
    requestId: string,
    allow: boolean,
    opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' },
  ) => Promise<void>;
  /** 最近使用的编程助手后端（新建标签默认） */
  lastBackend: HarnessBackend;
}

interface HarnessTabsValue extends HarnessTabsCore {
  /** 完整标签状态：任一标签变化都会换引用 */
  state: HarnessTabsState | null;
}

const Ctx = createContext<HarnessTabsValue | null>(null);
const CoreCtx = createContext<HarnessTabsCore | null>(null);

type LiveMap = Record<string, TabLive>;

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
const EMPTY_MESSAGES: HarnessTabMessage[] = [];
const LAST_BACKEND_KEY = 'nomi.tabs.lastBackend';

/** 还有后台子代理 / 后台任务时，停止或关闭前确认（它们会随进程一起结束） */
function confirmStopBackground(tab: HarnessTabMeta | undefined): boolean {
  const n = tab?.background ?? 0;
  if (!n) return true;
  return window.confirm(
    t('ui.chat-settings.background-tasks-are-still-running-and-will-be', String(n)),
  );
}

export function HarnessTabsProvider({ children }: { children: React.ReactNode }) {
  const available = harnessClient.available();
  const [state, setState] = useState<HarnessTabsState | null>(null);
  const [cache, setCache] = useState<Record<string, HarnessTabMessage[]>>({});
  /** 每个标签最近一次已观察到的工作目录；换目录即丢弃旧会话的渲染缓存。 */
  const cwdRef = useRef<Record<string, string>>({});
  const [live, setLive] = useState<LiveMap>({});
  // 提交后再发布给 useHarnessLive 的订阅方（同 aiChatStore）
  const [liveStore] = useState(createLiveStore);
  useLayoutEffect(() => {
    liveStore.set(live);
  }, [liveStore, live]);
  const [queues, setQueues] = useState<Record<string, string[]>>({});
  /** 已派发、尚未观察到标签进入运行态的标签：防止在状态更新前重复派发队列 */
  const dispatching = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const [lastBackend, setLastBackend] = useState<HarnessBackend>(() => {
    try {
      const v = localStorage.getItem(LAST_BACKEND_KEY);
      return v && isBuiltinCliId(v) ? v : 'claude';
    } catch {
      return 'claude';
    }
  });

  useEffect(() => {
    if (!available) return;
    void harnessClient
      .tabs()
      .then((s) => setState((cur) => shareTabsState(cur, s)))
      .catch(() => undefined);
    let flushPending: () => void = () => undefined;
    const off1 = harnessClient.onTabs((s) => {
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
    const off2 = harnessClient.onTabMessage(({ tabId, message }) => {
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
      for (const e of batch) {
        const list = byTab.get(e.tabId);
        if (list) list.push(e);
        else byTab.set(e.tabId, [e]);
      }
      setLive((cur) => {
        const next = { ...cur };
        for (const [tabId, evs] of byTab) next[tabId] = applyLiveEvents(cur[tabId], evs);
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
      if (e && typeof e.tabId === 'string') enqueue(e);
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
      .catch(() => undefined);
  }, [available, isCliTab, activeId, cache]);

  // 缓存只留最近用过的几个标签：切走后不再占内存，回来时重新读取
  const recentRef = useRef<string[]>([]);
  useEffect(() => {
    recentRef.current = [activeId, ...recentRef.current.filter((x) => x !== activeId)].slice(
      0,
      MAX_CACHED_TABS,
    );
    setCache((cur) => {
      if (Object.keys(cur).length <= MAX_CACHED_TABS) return cur;
      const next: Record<string, HarnessTabMessage[]> = {};
      for (const k of recentRef.current) if (cur[k]) next[k] = cur[k]!;
      return next;
    });
  }, [activeId, cache]);

  const create = useCallback(async (backend: HarnessBackend, cwd?: string) => {
    const tab = await harnessClient.createTab(cwd ? { backend, cwd } : { backend });
    setCache((cur) => ({ ...cur, [tab.id]: [] }));
    setLastBackend(backend);
    try {
      localStorage.setItem(LAST_BACKEND_KEY, backend);
    } catch {
      /* ignore */
    }
  }, []);
  const close = useCallback(async (id: string) => {
    if (id === MAIN_TAB_ID) return;
    // 关闭会拆掉 CLI 进程：还在跑的后台子代理会一起停掉，先确认（docs/design/cli-subagents.md §5）
    if (!confirmStopBackground(stateRef.current?.tabs.find((x) => x.id === id))) return;
    await harnessClient.closeTab(id);
    dispatching.current.delete(id);
    setQueues((cur) => {
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
  }, []);
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
        .then((s) => setState((cur) => shareTabsState(cur, s)))
        .catch(() => undefined);
      throw error;
    }
  }, []);
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
    async (tabId: string, text: string, images?: HarnessImageInput[]) => {
      setLive((cur) => ({ ...cur, [tabId]: { text: '', startedAt: Date.now() } }));
      // 结果经 tab-message 事件进入缓存；这里只吞掉错误（错误也会作为消息写入标签）
      await harnessClient.sendTab(tabId, text, images).catch(() => undefined);
    },
    [],
  );
  const sendToTab = useCallback(
    async (
      tabId: string,
      text: string,
      expect?: { backend?: HarnessBackend; cwd?: string },
      images?: HarnessImageInput[],
    ): Promise<boolean> => {
      if (tabId === MAIN_TAB_ID) return false;
      const tab = stateRef.current?.tabs.find((t) => t.id === tabId);
      if (!tab) return false;
      if (expect?.backend !== undefined && tab.backend !== expect.backend) return false;
      if (expect?.cwd !== undefined && tab.cwd !== expect.cwd) return false;
      if (tab.status === 'running' || tab.status === 'queued' || dispatching.current.has(tabId)) {
        // 排队不带图：有附图时拒绝入队，避免静默丢图
        if (images?.length) return false;
        setQueues((cur) => ({ ...cur, [tabId]: [...(cur[tabId] ?? []), text] }));
        return true;
      }
      dispatching.current.add(tabId);
      try {
        await dispatchSend(tabId, text, images);
      } finally {
        dispatching.current.delete(tabId);
        setTick((n) => n + 1);
      }
      return true;
    },
    [dispatchSend],
  );
  const hasTab = useCallback(
    (tabId: string) => !!stateRef.current?.tabs.some((t) => t.id === tabId),
    [],
  );
  const send = useCallback(
    async (text: string, images?: HarnessImageInput[]) => {
      if (!isCliTab) return;
      await sendToTab(activeId, text, undefined, images);
    },
    [isCliTab, activeId, sendToTab],
  );
  const removeQueued = useCallback(
    (index: number) =>
      setQueues((cur) => {
        const q = cur[activeId];
        if (!q || index < 0 || index >= q.length) return cur;
        return { ...cur, [activeId]: q.filter((_, i) => i !== index) };
      }),
    [activeId],
  );

  // 队列自动发送：标签空闲且队列非空时发出队首；已派发的标签要等它进入运行态后再继续
  useEffect(() => {
    if (!state) return;
    for (const tab of state.tabs) {
      if (tab.status === 'running' || tab.status === 'queued') {
        dispatching.current.delete(tab.id);
        continue;
      }
      const q = queues[tab.id];
      if (!q?.length || dispatching.current.has(tab.id)) continue;
      dispatching.current.add(tab.id);
      const [text, ...rest] = q;
      setQueues((cur) => ({ ...cur, [tab.id]: rest }));
      void dispatchSend(tab.id, text!).finally(() => {
        dispatching.current.delete(tab.id);
        setTick((n) => n + 1);
      });
    }
  }, [state, queues, tick, dispatchSend]);
  const cancel = useCallback(async () => {
    if (!isCliTab) return;
    if (!confirmStopBackground(stateRef.current?.tabs.find((x) => x.id === activeId))) return;
    await harnessClient.cancelTab(activeId);
  }, [isCliTab, activeId]);
  const replyPermission = useCallback(
    async (
      requestId: string,
      allow: boolean,
      opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' },
    ) => {
      if (!isCliTab) return;
      await harnessClient.replyPermission(activeId, requestId, allow, opts).catch(() => undefined);
      // 主进程会再发 permission-resolved；这里先乐观移除这一项（队列里的其它请求保留）
      setLive((cur) => {
        const prev = cur[activeId];
        if (!prev?.permissions?.some((p) => p.id === requestId)) return cur;
        const rest = prev.permissions.filter((p) => p.id !== requestId);
        const { permissions: _p, ...others } = prev;
        return { ...cur, [activeId]: rest.length ? { ...others, permissions: rest } : others };
      });
    },
    [isCliTab, activeId],
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
      queues,
      removeQueued,
      cancel,
      replyPermission,
      lastBackend,
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
      queues,
      removeQueued,
      cancel,
      replyPermission,
      lastBackend,
    ],
  );
  const value = useMemo<HarnessTabsValue>(() => ({ ...core, state }), [core, state]);
  return (
    <Ctx.Provider value={value}>
      <CoreCtx.Provider value={core}>
        <LiveCtx.Provider value={liveStore}>{children}</LiveCtx.Provider>
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
  queues: {},
  removeQueued: () => undefined,
  cancel: async () => undefined,
  replyPermission: async () => undefined,
  lastBackend: 'claude',
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
