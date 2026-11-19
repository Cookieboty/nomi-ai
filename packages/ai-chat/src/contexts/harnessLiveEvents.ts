/**
 * 对话标签的实时进度（useHarnessLive / useHarnessDetached 订阅的那两份）：主进程推送的 harness 事件按帧合批，
 * 折叠进各标签的 TabLive（纯函数在 utils/liveState）。标签的元数据 / 消息缓存订阅与队列状态机在
 * HarnessTabsContext / harnessPendingQueue 里。
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';

import { harnessClient, type HarnessLiveEvent } from '../services/harnessClient';
import { applyDetachedEvents, applyLiveEvents, type TabLive } from '../utils/liveState';

export type LiveMap = Record<string, TabLive>;

/**
 * 各标签的实时进度单独作为外部 store：流式期间约每帧更新一次，放进上下文 value 会让所有
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
export const LiveCtx = createContext<LiveStore>(EMPTY_LIVE_STORE);
/**
 * 来源标签空闲时子代理的实时状态（用户在子任务侧栏里直接对它说话后它接着跑）：状态和逐字增量。
 * 和上面的实时进度分开放：标签空闲 / 一轮定稿时不清它
 */
export const DetachedCtx = createContext<LiveStore>(createLiveStore());

/**
 * 主进程的实时事件 → 两份实时进度（按帧合批）。与标签状态 / 消息的订阅同一个 effect、按同一个顺序挂上：
 * 状态 / 定稿消息的处理器先跑，它们经 flush() 把已入队的事件先落下（主进程保证事件先于标签状态 / 定稿消息到达），
 * 之后这个 handler 再收。一帧内到达的所有事件只触发一次 setState（流式文本 / 上千个工具事件不再逐条重渲染）。
 */
export interface LiveEventStream {
  /** 收到一条事件（主进程给的原始值）：先入队，工具开始时把标签等着的插入消息交出去 */
  handle: (raw: unknown) => void;
  /** 把已入队的立即落下（标签状态 / 定稿消息到达时） */
  flush: () => void;
  /** 卸下：丢掉缓冲与定时器 */
  dispose: () => void;
}

export function createLiveEventStream(opts: {
  setLive: (fn: (cur: LiveMap) => LiveMap) => void;
  setDetached: (fn: (cur: LiveMap) => LiveMap) => void;
  /** 标签等着的插入消息：现在可以交出去了 */
  onToolStart: (tabId: string) => void;
}): LiveEventStream {
  const { setLive, setDetached, onToolStart } = opts;
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
  const handle = (raw: unknown) => {
    const e = raw as HarnessLiveEvent;
    if (!e || typeof e.tabId !== 'string') return;
    pending.push(e);
    if (!raf && !timer) {
      raf = requestAnimationFrame(flush);
      // 窗口隐藏 / 最小化时 rAF 不触发：用定时器兜底，避免缓冲无限增长
      timer = window.setTimeout(flush, 100);
    }
    // 工具开始：这个标签等着的插入消息现在交出去（CLI 在这个工具的结果处取走）
    if (e.type === 'tool' && e.status === 'start' && !(e as { detached?: boolean }).detached)
      onToolStart(e.tabId);
  };
  const dispose = () => {
    pending.length = 0;
    if (raf) cancelAnimationFrame(raf);
    if (timer) window.clearTimeout(timer);
    raf = 0;
    timer = 0;
  };
  return { handle, flush, dispose };
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

export { createLiveStore };
export type { LiveStore };
