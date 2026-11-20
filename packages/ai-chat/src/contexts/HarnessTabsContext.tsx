/**
 * 对话标签状态：主进程是唯一数据源（标签元数据 + CLI 标签消息），这里只做订阅与缓存。
 * 标签 'main' 为原有对话（消息走 AiChatContext）；其它标签只绑定 agent 后端。
 *
 * 按职责分开（这里保留 Provider、标签元数据 / 消息缓存与上下文，下面几份从这里转出）：
 * - 发送与待发列表（队列状态机、重启后挂回）：harnessPendingQueue；
 * - 实时进度 / 实时事件的合批与 useHarnessLive / useHarnessDetached：harnessLiveEvents；
 * - 待发失败提示的形状、「是不是同一条」与挂回的附件缺失标记：harnessTabsHelpers。
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
import type { RunnerPreset } from '../services/delegateClient';
import {
  MAIN_TAB_ID,
  harnessClient,
  type HarnessBackend,
  type HarnessTabMessage,
  type HarnessTabMeta,
  type HarnessTabsState,
} from '../services/harnessClient';
import { replyPermissionRequest } from '../services/permissionReply';
import { syncDelegateAliases } from '../utils/delegateAlias';
import type { LiveStatus, TabLive } from '../utils/liveState';
import type { PendingImage, PendingMode } from '../utils/pendingSends';
import { findReusableTab, isEmptyTab } from '../utils/reusableTab';
import { shareTabsState } from '../utils/shareTabsState';

import {
  DetachedCtx,
  LiveCtx,
  createLiveEventStream,
  createLiveStore,
  type LiveMap,
} from './harnessLiveEvents';
import { useHarnessPendingQueue, type HarnessPendingQueueApi } from './harnessPendingQueue';
import type { PendingSendFailure } from './harnessTabsHelpers';

export type { TabLive, LiveStatus };
export { useHarnessDetached, useHarnessLive } from './harnessLiveEvents';
export { sameFailedSend, type PendingSendFailure } from './harnessTabsHelpers';

/** 内存里最多缓存几个标签的消息（含当前）：其余切走后丢弃，回来时重新从主进程读取 */
const MAX_CACHED_TABS = 4;

/**
 * 不含完整标签列表的部分：后台标签的状态 / 未读变化不会让它换引用（activeTab 经结构共享，
 * 只有当前标签真的变了才换）。只关心当前标签与操作的消费者（如 App）用 useHarnessTabsCore()。
 */
export interface HarnessTabsCore extends HarnessPendingQueueApi {
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
  /** 标签是否仍存在（读最新状态，不依赖渲染闭包） */
  hasTab: (tabId: string) => boolean;
  /**
   * 从当前标签的某条用户消息重新发送（重试 / 编辑）：它和之后的消息全部删除，
   * CLI 会话丢弃、剩余对话作为前文开新会话，再发 text
   */
  resendFrom: (messageId: string, text: string) => Promise<void>;
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
  /** 最近使用的 agent 后端（新建标签默认） */
  lastBackend: HarnessBackend;
}

export interface HarnessTabsValue extends HarnessTabsCore {
  /** 完整标签状态：任一标签变化都会换引用 */
  state: HarnessTabsState | null;
}

const Ctx = createContext<HarnessTabsValue | null>(null);
const CoreCtx = createContext<HarnessTabsCore | null>(null);

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
  // 最新已提交的状态：给异步回调与队列状态机读（渲染闭包里的 activeId / status 可能已过期；layout effect 先于下面的订阅同步）
  const stateRef = useRef<HarnessTabsState | null>(null);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
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
  const [lastBackend, setLastBackend] = useState<HarnessBackend>(() => {
    try {
      const v = localStorage.getItem(LAST_BACKEND_KEY);
      return v && isBuiltinCliId(v) ? v : 'claude';
    } catch {
      return 'claude';
    }
  });

  // 发送与待发列表（队列状态机，见 harnessPendingQueue）
  const queue = useHarnessPendingQueue({
    stateRef,
    state,
    // 当前标签：下面算出来之前队列用不上（send / flushPending 都先看 isCliTab）
    activeId: state?.activeTabId ?? MAIN_TAB_ID,
    isCliTab: !!state?.activeTabId && state.activeTabId !== MAIN_TAB_ID,
    liveStore,
    setLive,
  });

  useEffect(() => {
    if (!available) {
      startupBrandIntro.taskDone('tabs');
      return;
    }
    // 实时事件按帧合批（两份实时进度），工具开始时交出等着的插入消息（见 harnessLiveEvents）。
    // 和标签状态 / 消息的订阅在同一个 effect 里、按这个顺序挂上：状态 / 定稿消息先落下已入队的实时事件
    const stream = createLiveEventStream({
      setLive,
      setDetached,
      onToolStart: (tabId: string) => void queue.deliverSteer(tabId),
    });
    void harnessClient
      .tabs()
      .then((s) => {
        syncDelegateAliases(s.tabs);
        setState((cur) => shareTabsState(cur, s));
      })
      .catch(() => startupBrandIntro.taskDone('tabs'));
    const off1 = harnessClient.onTabs((s) => {
      syncDelegateAliases(s.tabs);
      // 先落下已入队的实时事件（主进程保证它们先于本次标签状态到达），再清理已结束的标签
      stream.flush();
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
      if (settles) stream.flush();
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
    const off3 = harnessClient.onEvents((batch) => batch.forEach(stream.handle));
    const off4 = harnessClient.onEvent(stream.handle);
    return () => {
      off1();
      off2();
      off3();
      off4();
      stream.dispose();
    };
  }, [available, queue.deliverSteer]);

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
      queue.dropTab(id);
      setCache((cur) => {
        const next = { ...cur };
        delete next[id];
        return next;
      });
    },
    [queue.dropTab],
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
        !queue.hasQueued(prevActive.id);
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
    [activate, cacheStore, queue.hasQueued],
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
  const hasTab = useCallback(
    (tabId: string) => !!stateRef.current?.tabs.some((t) => t.id === tabId),
    [],
  );
  const resendFromTab = useCallback(
    async (tabId: string, messageId: string, text: string) => {
      if (tabId === MAIN_TAB_ID) return;
      if (!stateRef.current?.tabs.some((t) => t.id === tabId)) return;
      const kept = await harnessClient.rewindTab(tabId, messageId);
      setCache((cur) => ({ ...cur, [tabId]: kept }));
      await queue.sendToTab(tabId, text);
    },
    [queue.sendToTab],
  );
  const resendFrom = useCallback(
    async (messageId: string, text: string) => {
      if (!isCliTab) return;
      await resendFromTab(activeId, messageId, text);
    },
    [isCliTab, activeId, resendFromTab],
  );
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
  // 队列那份摊进 core：每一项都是稳定的回调 / 状态，下面逐个列出，引用不变时 core 与 value 也不换（消费者不重渲染）
  const core = useMemo<HarnessTabsCore>(
    () => ({
      queues: queue.queues,
      send: queue.send,
      sendToTab: queue.sendToTab,
      removePending: queue.removePending,
      removePendingFrom: queue.removePendingFrom,
      sendPendingTextOnly: queue.sendPendingTextOnly,
      flushPending: queue.flushPending,
      flushPendingFor: queue.flushPendingFor,
      sendFails: queue.sendFails,
      retryFailedSend: queue.retryFailedSend,
      inFlight: queue.inFlight,
      clearSendError: queue.clearSendError,
      restorePending: queue.restorePending,
      pendingRestored: queue.pendingRestored,
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
      hasTab,
      resendFrom,
      cancel,
      replyPermission,
      replyPermissionFor,
      resendFromTab,
      cancelRun,
      lastBackend,
    }),
    [
      queue.queues,
      queue.send,
      queue.sendToTab,
      queue.removePending,
      queue.removePendingFrom,
      queue.sendPendingTextOnly,
      queue.flushPending,
      queue.flushPendingFor,
      queue.sendFails,
      queue.retryFailedSend,
      queue.inFlight,
      queue.clearSendError,
      queue.restorePending,
      queue.pendingRestored,
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
      hasTab,
      resendFrom,
      cancel,
      replyPermission,
      replyPermissionFor,
      resendFromTab,
      cancelRun,
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
  removePendingFrom: () => undefined,
  sendPendingTextOnly: () => undefined,
  flushPending: async () => false,
  flushPendingFor: async () => false,
  cancel: async () => undefined,
  replyPermission: async () => undefined,
  replyPermissionFor: async () => undefined,
  resendFromTab: async () => undefined,
  cancelRun: async () => undefined,
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
