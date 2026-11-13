/**
 * 对话标签状态：主进程是唯一数据源（标签元数据 + CLI 标签消息），这里只做订阅与缓存。
 * 标签 'main' 为原有对话（消息走 AiChatContext）；其它标签只绑定编程助手后端。
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

import { confirmDialog } from '../components/ConfirmDialog';
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
import { replyPermissionRequest } from '../services/permissionReply';
import { canSteer } from '../utils/cliCaps';
import { applyLiveEvents, type LiveStatus, type TabLive } from '../utils/liveState';
import {
  hasRunningTool,
  mergePending,
  newPendingId,
  requeue,
  takeSteer,
  type PendingMode,
  type PendingSend,
} from '../utils/pendingSends';
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
  /** projectId：在哪个项目里开；不给 = 默认目录 */
  create: (backend: HarnessBackend, projectId?: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  activate: (id: string) => Promise<void>;
  cycle: (dir: 1 | -1) => void;
  selectIndex: (i: number) => void;
  /** 发送；当前标签正在运行 / 排队时改为进队列，当前轮结束后自动发送。附图仅空闲直发（排队不带图）。 */
  send: (text: string, images?: HarnessImageInput[], mode?: PendingMode) => Promise<void>;
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
    /** 标签在运行时：steer（Enter，默认）插入这一轮 / queue（Ctrl+Enter）排队到这一轮结束 */
    mode?: PendingMode,
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
  /** 停止指定标签这一轮，待发列表合成一条马上发出 */
  flushPendingFor: (tabId: string) => Promise<boolean>;
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
  const [queues, setQueues] = useState<Record<string, PendingSend[]>>({});
  const queuesRef = useRef(queues);
  /** 更新待发列表并同步 ref（交付判断读最新值，不等渲染） */
  const updateQueues = useCallback(
    (fn: (cur: Record<string, PendingSend[]>) => Record<string, PendingSend[]>) => {
      queuesRef.current = fn(queuesRef.current);
      setQueues(queuesRef.current);
    },
    [],
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
      if (!e || typeof e.tabId !== 'string') return;
      enqueue(e);
      // 工具开始：这个标签等着的插入消息现在交出去（CLI 在这个工具的结果处取走）
      if (e.type === 'tool' && e.status === 'start') void deliverRef.current(e.tabId);
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

  const create = useCallback(async (backend: HarnessBackend, projectId?: string) => {
    const tab = await harnessClient.createTab(projectId ? { backend, projectId } : { backend });
    setCache((cur) => ({ ...cur, [tab.id]: [] }));
    setLastBackend(backend);
    try {
      localStorage.setItem(LAST_BACKEND_KEY, backend);
    } catch {
      /* ignore */
    }
  }, []);
  const close = useCallback(
    async (id: string) => {
      if (id === MAIN_TAB_ID) return;
      // 关闭会拆掉 CLI 进程：还在跑的后台子代理会一起停掉，先确认（docs/development/coding-agents.md）
      if (!(await confirmStopBackground(stateRef.current?.tabs.find((x) => x.id === id)))) return;
      await harnessClient.closeTab(id);
      dispatching.current.delete(id);
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
      mode: PendingMode = 'steer',
    ): Promise<boolean> => {
      if (tabId === MAIN_TAB_ID) return false;
      const tab = stateRef.current?.tabs.find((t) => t.id === tabId);
      if (!tab) return false;
      if (expect?.backend !== undefined && tab.backend !== expect.backend) return false;
      if (expect?.cwd !== undefined && tab.cwd !== expect.cwd) return false;
      if (tab.status === 'running' || tab.status === 'queued' || dispatching.current.has(tabId)) {
        // 排队不带图：有附图时拒绝入队，避免静默丢图
        if (images?.length) return false;
        // 后端不能中途插入（Gemini / dsh / 外部 CLI）：一律排队
        const m: PendingMode = mode === 'steer' && canSteer(tab.backend) ? 'steer' : 'queue';
        const item: PendingSend = { id: newPendingId(), text, mode: m };
        updateQueues((cur) => ({ ...cur, [tabId]: [...(cur[tabId] ?? []), item] }));
        // 正好有工具在跑：现在交出去，这个工具的结果回给模型时一起带上
        if (m === 'steer' && hasRunningTool(liveStore.get()[tabId]?.trace))
          void deliverSteer(tabId);
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
    [dispatchSend, updateQueues, deliverSteer, liveStore],
  );
  const hasTab = useCallback(
    (tabId: string) => !!stateRef.current?.tabs.some((t) => t.id === tabId),
    [],
  );
  const send = useCallback(
    async (text: string, images?: HarnessImageInput[], mode?: PendingMode) => {
      if (!isCliTab) return;
      await sendToTab(activeId, text, undefined, images, mode);
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
  const flushPendingFor = useCallback(
    async (tabId: string) => {
      const all = queuesRef.current[tabId] ?? [];
      if (tabId === MAIN_TAB_ID || !all.length) return false;
      if (!stateRef.current?.tabs.some((t) => t.id === tabId)) return false;
      // 合成一条排在最前：停下来后队列自动发送马上发出它
      updateQueues((cur) => ({
        ...cur,
        [tabId]: [{ id: newPendingId(), text: mergePending(all), mode: 'queue' }],
      }));
      await harnessClient.cancelTab(tabId);
      return true;
    },
    [updateQueues],
  );
  const flushPending = useCallback(async () => {
    if (!isCliTab) return false;
    return flushPendingFor(activeId);
  }, [isCliTab, activeId, flushPendingFor]);

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
      if (delivering.current.has(tab.id)) continue;
      dispatching.current.add(tab.id);
      const [next, ...rest] = q;
      updateQueues((cur) => ({ ...cur, [tab.id]: rest }));
      void dispatchSend(tab.id, next!.text).finally(() => {
        dispatching.current.delete(tab.id);
        setTick((n) => n + 1);
      });
    }
  }, [state, queues, tick, dispatchSend, updateQueues]);
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
          <CacheCtx.Provider value={cacheStore}>
            <PinCtx.Provider value={tabCacheApi}>{children}</PinCtx.Provider>
          </CacheCtx.Provider>
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
