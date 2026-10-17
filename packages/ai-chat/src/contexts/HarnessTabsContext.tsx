/**
 * 对话标签状态：主进程是唯一数据源（标签元数据 + CLI 标签消息），这里只做订阅与缓存。
 * 标签 'main' 为原有对话（消息走 AiChatContext）；其它标签只绑定编程助手后端。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  MAIN_TAB_ID,
  harnessClient,
  type HarnessBackend,
  type HarnessLiveEvent,
  type HarnessTabMessage,
  type HarnessTabMeta,
  type HarnessTabsState,
} from '../services/harnessClient';
import { applyLiveEvents, type LiveStatus, type TabLive } from '../utils/liveState';

/** 内存里最多缓存几个标签的消息（含当前）：其余切走后丢弃，回来时重新从主进程读取 */
const MAX_CACHED_TABS = 4;

export type { TabLive, LiveStatus };

interface HarnessTabsValue {
  available: boolean;
  state: HarnessTabsState | null;
  activeTab: HarnessTabMeta | null;
  /** 当前标签是独立的 CLI 标签（非 main） */
  isCliTab: boolean;
  messages: HarnessTabMessage[];
  live: Record<string, TabLive>;
  create: (backend: HarnessBackend, cwd?: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  activate: (id: string) => Promise<void>;
  cycle: (dir: 1 | -1) => void;
  selectIndex: (i: number) => void;
  /** 发送；当前标签正在运行 / 排队时改为进队列，当前轮结束后自动发送 */
  send: (text: string) => Promise<void>;
  /** 各标签排队中的待发消息 */
  queues: Record<string, string[]>;
  removeQueued: (index: number) => void;
  cancel: () => Promise<void>;
  replyPermission: (requestId: string, allow: boolean) => Promise<void>;
  setMaxConcurrent: (n: number) => Promise<void>;
  /** 最近使用的编程助手后端（新建标签默认） */
  lastBackend: HarnessBackend;
}

const Ctx = createContext<HarnessTabsValue | null>(null);
const EMPTY_MESSAGES: HarnessTabMessage[] = [];
const LAST_BACKEND_KEY = 'nomi.tabs.lastBackend';

export function HarnessTabsProvider({ children }: { children: React.ReactNode }) {
  const available = harnessClient.available();
  const [state, setState] = useState<HarnessTabsState | null>(null);
  const [cache, setCache] = useState<Record<string, HarnessTabMessage[]>>({});
  const [live, setLive] = useState<Record<string, TabLive>>({});
  const [queues, setQueues] = useState<Record<string, string[]>>({});
  /** 已派发、尚未观察到标签进入运行态的标签：防止在状态更新前重复派发队列 */
  const dispatching = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const [lastBackend, setLastBackend] = useState<HarnessBackend>(() => {
    try {
      const v = localStorage.getItem(LAST_BACKEND_KEY);
      return v === 'codex' || v === 'dsh' || v === 'grok' ? v : 'claude';
    } catch {
      return 'claude';
    }
  });

  useEffect(() => {
    if (!available) return;
    void harnessClient
      .tabs()
      .then(setState)
      .catch(() => undefined);
    let flushPending: () => void = () => undefined;
    const off1 = harnessClient.onTabs((s) => {
      // 先落下已入队的实时事件（主进程保证它们先于本次标签状态到达），再清理已结束的标签
      flushPending();
      setState(s);
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
    const off2 = harnessClient.onTabMessage(({ tabId, message }) =>
      setCache((cur) =>
        cur[tabId] && !cur[tabId]!.some((m) => m.id === message.id)
          ? { ...cur, [tabId]: [...cur[tabId]!, message] }
          : cur,
      ),
    );
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
  const activate = useCallback(async (id: string) => {
    await harnessClient.activateTab(id);
  }, []);
  const ids = useMemo(() => state?.tabs.map((t) => t.id) ?? [], [state]);
  const cycle = useCallback(
    (dir: 1 | -1) => {
      if (ids.length < 2) return;
      const i = ids.indexOf(activeId);
      void harnessClient.activateTab(ids[(i + dir + ids.length) % ids.length]!);
    },
    [ids, activeId],
  );
  const selectIndex = useCallback(
    (i: number) => {
      const id = i >= 8 ? ids[ids.length - 1] : ids[i];
      if (id) void harnessClient.activateTab(id);
    },
    [ids],
  );
  const dispatchSend = useCallback(async (tabId: string, text: string) => {
    setLive((cur) => ({ ...cur, [tabId]: { text: '', startedAt: Date.now() } }));
    // 结果经 tab-message 事件进入缓存；这里只吞掉错误（错误也会作为消息写入标签）
    await harnessClient.sendTab(tabId, text).catch(() => undefined);
  }, []);
  const send = useCallback(
    async (text: string) => {
      if (!isCliTab) return;
      const st = activeTab?.status;
      if (st === 'running' || st === 'queued' || dispatching.current.has(activeId)) {
        setQueues((cur) => ({ ...cur, [activeId]: [...(cur[activeId] ?? []), text] }));
        return;
      }
      dispatching.current.add(activeId);
      await dispatchSend(activeId, text);
      dispatching.current.delete(activeId);
      setTick((n) => n + 1);
    },
    [isCliTab, activeId, activeTab?.status, dispatchSend],
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
    if (isCliTab) await harnessClient.cancelTab(activeId);
  }, [isCliTab, activeId]);
  const replyPermission = useCallback(
    async (requestId: string, allow: boolean) => {
      if (!isCliTab) return;
      await harnessClient.replyPermission(activeId, requestId, allow).catch(() => undefined);
      setLive((cur) => {
        const prev = cur[activeId];
        if (!prev?.permission || prev.permission.id !== requestId) return cur;
        const { permission: _p, ...rest } = prev;
        return { ...cur, [activeId]: rest };
      });
    },
    [isCliTab, activeId],
  );
  const setMaxConcurrent = useCallback(async (n: number) => {
    const next = await harnessClient.setMaxConcurrent(n);
    setState(next);
  }, []);

  const messages = (isCliTab && cache[activeId]) || EMPTY_MESSAGES;
  const value = useMemo<HarnessTabsValue>(
    () => ({
      available,
      state,
      activeTab,
      isCliTab,
      messages,
      live,
      create,
      close,
      rename,
      activate,
      cycle,
      selectIndex,
      send,
      queues,
      removeQueued,
      cancel,
      replyPermission,
      setMaxConcurrent,
      lastBackend,
    }),
    [
      available,
      state,
      activeTab,
      isCliTab,
      messages,
      live,
      create,
      close,
      rename,
      activate,
      cycle,
      selectIndex,
      send,
      queues,
      removeQueued,
      cancel,
      replyPermission,
      setMaxConcurrent,
      lastBackend,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const EMPTY: HarnessTabsValue = {
  available: false,
  state: null,
  activeTab: null,
  isCliTab: false,
  messages: [],
  live: {},
  create: async () => undefined,
  close: async () => undefined,
  rename: async () => undefined,
  activate: async () => undefined,
  cycle: () => undefined,
  selectIndex: () => undefined,
  send: async () => undefined,
  queues: {},
  removeQueued: () => undefined,
  cancel: async () => undefined,
  replyPermission: async () => undefined,
  setMaxConcurrent: async () => undefined,
  lastBackend: 'claude',
};

export function useHarnessTabs(): HarnessTabsValue {
  return useContext(Ctx) ?? EMPTY;
}
