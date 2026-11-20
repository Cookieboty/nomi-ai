/**
 * agent 标签的发送与待发列表（输入框上方的队列）状态机：规则见 utils/pendingSends，落盘见
 * services/pendingSendsStore。从 HarnessTabsContext 取出，逻辑不变：
 * - 插入（steer）：等到安全点交给这一轮（下一个工具开始，或入列时正好有工具在跑）；交不出去改为排队；
 * - 排队（queue）：标签空闲后按顺序自动发送；标签进入运行态（内核收下这次请求）才算交付；
 * - 派发失败：整条（正文 + 图片）留在队首并给出可见提示，之后点发送 / 「重试」才再派发——不自动重试、不循环；
 *   Esc 合成发送会清掉旧提示、解开挂起；
 * - 挂回：应用在这一轮中途重启后把存下的列表挂回（带图但图没落盘的标「附件缺失」，不自动发出）。
 */
import { t as tr } from '@nomi-ai/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureHarnessImages } from '../services/chatImages';
import {
  MAIN_TAB_ID,
  harnessClient,
  type HarnessBackend,
  type HarnessTabMeta,
  type HarnessTabsState,
} from '../services/harnessClient';
import {
  matchesTabIdentity,
  mergeRestoredPending,
  openPendingSends,
  pendingKey,
  sentPendingTexts,
  type PendingSendStore,
  type PendingTabIdentity,
  type PersistWhy,
} from '../services/pendingSendsStore';
import { canSteer } from '../utils/cliCaps';
import {
  hasRunningTool,
  mergePending,
  mergePendingBatches,
  newPendingId,
  requeue,
  takeSteer,
  type PendingImage,
  type PendingMode,
  type PendingSend,
} from '../utils/pendingSends';

import type { LiveMap, LiveStore } from './harnessLiveEvents';
import { sameFailedSend, type PendingSendFailure } from './harnessTabsHelpers';

/** Esc「停止并马上发送」时合成的一条最多带几张图（按后端图片上限分批的同一批上限） */
const FLUSH_MAX_IMAGES = 8;

const tabIdentityOf = (tab: HarnessTabMeta): PendingTabIdentity => ({
  tabId: tab.id,
  backend: tab.backend,
  cwd: tab.cwd,
  cliSessionId: tab.cliSessionId ?? null,
  createdAt: tab.createdAt,
});

/** 待发列表 / 发送相关的操作与状态（HarnessTabsCore 的一部分） */
export interface HarnessPendingQueueApi {
  /** 发送；当前标签正在运行 / 排队时改为进队列（含附图，不走 steer 丢图），当前轮结束后自动发送。 */
  send: (
    text: string,
    images?: readonly PendingImage[],
    mode?: PendingMode,
    onError?: (message: string) => void,
    imageOnly?: boolean,
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
    imageOnly?: boolean,
  ) => Promise<boolean>;
  /** 各标签运行中发出、还没交出去的消息（输入框上方的待发列表，见 utils/pendingSends） */
  queues: Record<string, PendingSend[]>;
  /** 从当前标签的待发列表删掉一条（撤回修改 / 删除） */
  removePending: (id: string) => void;
  /** 从指定标签的待发列表删掉一条 */
  removePendingFrom: (tabId: string, id: string) => void;
  /** 重启后丢失图片的有文条目：用户确认「仅发送文字」后去掉缺失标记恢复自动发送 */
  sendPendingTextOnly: (tabId: string, id: string) => void;
  /** Esc：停止当前标签这一轮，待发列表合成一条马上发出；列表为空时 false */
  flushPending: () => Promise<boolean>;
  /** 停止指定标签这一轮，待发列表合成一条马上发出 */
  flushPendingFor: (tabId: string) => Promise<boolean>;
  /** 各标签自动发送失败的提示（正文还在待发列表最前面）；没有失败的标签为空 */
  sendFails: Record<string, PendingSendFailure>;
  /** 明确重试队首失败的那条（同样不自动重试；失败再挂回） */
  retryFailedSend: (tabId: string) => void;
  /** 队首那一条正在派发（还没被内核收下）的待发 id */
  inFlight: Record<string, string>;
  /** 关掉某个标签的自动发送失败提示 */
  clearSendError: (tabId: string) => void;
  /**
   * 挂回这个标签的待发列表（存在 localStorage 的 tab:<标签 id>，见 services/pendingSendsStore）：
   * 启动后调用一次，之后这个标签的每次改动（入列 / 交付 / 删除 / Esc / 发送）都写回那一组；
   * 标签已经没有（关了）或还在运行时不挂（运行中的列表是当前界面的）。返回有没有挂回（有恢复 / 接管的条目）
   */
  restorePending: (key: string) => boolean;
  /** 这个标签是不是已经挂过待发列表了 */
  pendingRestored: (tabId: string) => boolean;
}

export interface UseHarnessPendingQueueResult extends HarnessPendingQueueApi {
  /**
   * 标签关了：它存下的待发列表这份不再需要（也不会再让别的窗口发），列表里的条目删掉。
   * 运行态的派发标记由调用方一并清（见 HarnessTabsContext.close）。
   */
  dropTab: (tabId: string) => void;
  /** 这个标签此刻有没有待发列表（新建会话时判空用） */
  hasQueued: (tabId: string) => boolean;
  /** 工具开始：把这个标签等着的插入消息交出去（实时事件流调用，见 harnessLiveEvents） */
  deliverSteer: (tabId: string) => Promise<void>;
}

interface Options {
  /** 最新一份标签状态（不放进依赖：它在 setState 时经 layout effect 同步，这里读到的就是对得上渲染的那份） */
  stateRef: { readonly current: HarnessTabsState | null };
  /** 这个渲染时的那一份标签状态（结构共享：真的变了才换引用），挂回 / 重试 / 队列自动发送这几段 effect 按它重跑 */
  state: HarnessTabsState | null;
  /** 当前标签；main 时 isCliTab 为 false（send / flushPending / removePending 只对 CLI 标签生效） */
  activeId: string;
  isCliTab: boolean;
  /** 实时进度（store 与 setter 由 HarnessTabsProvider 提供：派发占位 / 交回权限都改它） */
  liveStore: LiveStore;
  setLive: (fn: (cur: LiveMap) => LiveMap) => void;
}

export function useHarnessPendingQueue(options: Options): UseHarnessPendingQueueResult {
  const { stateRef, state, activeId, isCliTab, liveStore, setLive } = options;
  const [queues, setQueues] = useState<Record<string, PendingSend[]>>({});
  const queuesRef = useRef(queues);
  /** 各标签的待发列表写回本地的那份（挂回或首次入队创建的组，键 = 标签 id）：入列 / 交付 / 发送之后都同步 */
  const pendingStores = useRef(new Map<string, PendingSendStore>());
  const tabIdentitiesRef = useRef(new Map<string, PendingTabIdentity>());
  const knownTabIds = useRef(new Set<string>());
  const ensureTabStore = useCallback((tab: HarnessTabMeta): PendingSendStore => {
    const existing = pendingStores.current.get(tab.id);
    if (existing) return existing;
    const identity = tabIdentityOf(tab);
    const store = openPendingSends({}, pendingKey('tab', tab.id), { tabIdentity: identity });
    pendingStores.current.set(tab.id, store);
    tabIdentitiesRef.current.set(tab.id, identity);
    return store;
  }, []);
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
    [persistTabQueue, pruneAcks],
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
        if (!ok && stateRef.current?.tabs.some((t) => t.id === tabId)) {
          updateQueues((cur) => ({ ...cur, [tabId]: requeue(cur[tabId] ?? [], picked) }));
        }
      } finally {
        delivering.current.delete(tabId);
        setTick((n) => n + 1);
      }
    },
    [stateRef, updateQueues],
  );
  const deliverRef = useRef(deliverSteer);
  useEffect(() => {
    deliverRef.current = deliverSteer;
  }, [deliverSteer]);
  /**
   * 已派发、尚未观察到标签进入运行态的标签（值为派发 token）：防止在状态更新前重复派发队列。
   * 同一代里只派发一次；自动发送失败并提示后，下次点发送 / 明确重试才再派发（不自动重试、不循环）。
   */
  const dispatchSeq = useRef(0);
  const activeDispatch = useRef(new Map<string, { token: number; itemId: string }>());
  const dispatching = useRef(new Map<string, number>());
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

  /** 让指定标签（或指定待发项）当前在途派发失效，防止删掉/撤回后晚到的失败回调复活它 */
  const invalidateDispatch = useCallback((tabId: string, onlyItemId?: string) => {
    const act = activeDispatch.current.get(tabId);
    if (act && (!onlyItemId || act.itemId === onlyItemId)) {
      activeDispatch.current.delete(tabId);
    }
    if (!onlyItemId || act?.itemId === onlyItemId) {
      dispatching.current.delete(tabId);
      setInFlight((cur) => {
        if (!(tabId in cur)) return cur;
        if (onlyItemId && cur[tabId] !== onlyItemId) return cur;
        const copy = { ...cur };
        delete copy[tabId];
        return copy;
      });
    }
    const ack = ackedSends.current.get(tabId);
    if (ack && (!onlyItemId || ack.id === onlyItemId)) {
      ackedSends.current.delete(tabId);
    }
  }, []);

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
   * 标签不见了（关了 / 重启后主进程没恢复它）或同一标签id 对应的会话身份变了（换后端/目录/新建或重置CLI会话）：
   * 立即失效在途派发并清除旧存储，绝不串到新会话。
   */
  useEffect(() => {
    if (!state) return;
    const tabMap = new Map(state.tabs.map((t) => [t.id, t]));
    const known = knownTabIds.current;
    if (known.size) {
      for (const [id, store] of pendingStores.current) {
        if (!tabMap.has(id) && known.has(id)) {
          pendingStores.current.delete(id);
          tabIdentitiesRef.current.delete(id);
          invalidateDispatch(id);
          clearSendError(id);
          parkedTabs.current.delete(id);
          manualRetry.current.delete(id);
          runningAcked.current.delete(id);
          void store.persist('clear').catch(() => undefined);
        }
      }
    }
    for (const tab of state.tabs) {
      if (tab.id === MAIN_TAB_ID) continue;
      const nextId = tabIdentityOf(tab);
      const prevId = tabIdentitiesRef.current.get(tab.id);
      if (prevId && !matchesTabIdentity(prevId, nextId)) {
        invalidateDispatch(tab.id);
        clearSendError(tab.id);
        parkedTabs.current.delete(tab.id);
        manualRetry.current.delete(tab.id);
        runningAcked.current.delete(tab.id);
        const oldStore = pendingStores.current.get(tab.id);
        pendingStores.current.delete(tab.id);
        if (oldStore) void oldStore.persist('clear').catch(() => undefined);
        tabIdentitiesRef.current.set(tab.id, nextId);
        updateQueues((cur) => {
          if (!cur[tab.id]) return cur;
          const copy = { ...cur };
          delete copy[tab.id];
          return copy;
        });
        continue;
      }
      tabIdentitiesRef.current.set(tab.id, nextId);
      pendingStores.current.get(tab.id)?.updateTabIdentity?.(nextId);
    }
    knownTabIds.current = new Set(tabMap.keys());
  }, [state, invalidateDispatch, clearSendError, updateQueues]);

  /** 派发一条（先占住这个标签的实时进度，发送前预检等错误在这里捕获并立刻清理它） */
  const dispatchSend = useCallback(
    async (
      tabId: string,
      text: string,
      images?: readonly PendingImage[],
    ): Promise<string | null> => {
      setLive((cur) => ({ ...cur, [tabId]: { text: '', startedAt: Date.now() } }));
      try {
        const harnessImages = images?.length ? await ensureHarnessImages(images) : undefined;
        const actualText =
          !text.trim() && images?.length
            ? tr('ui.knowledge-local.please-take-a-look-at-this-image')
            : text;
        // 结果经 tab-message 事件进入缓存；发送前预检等错误在此捕获并立刻清理占位 live 状态
        await harnessClient.sendTab(tabId, actualText, harnessImages);
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
    [setLive],
  );
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
   * 自动发送（排队 / 挂回的消息）队首失败：只有标签与条目仍在队列中时才记失败提示（防止被删 / 撤回的条目因
   * 晚到失败回调而复活）。
   */
  const failQueuedSend = useCallback(
    (tabId: string, item: PendingSend, message: string) => {
      if (!stateRef.current?.tabs.some((t) => t.id === tabId)) return;
      const current = queuesRef.current[tabId] ?? [];
      const matched = current.find((i) => i.id === item.id);
      if (!matched) return;
      if (pendingStores.current.has(tabId)) {
        persistTabQueue(tabId, current);
      }
      markSendError(tabId, matched, message);
    },
    [stateRef, persistTabQueue, markSendError],
  );

  /**
   * 队列自动发送一条（标签空闲）：成功才从列表移除；失败留在队首并给出可见原因（不自动重试）。
   * 用 ref 调，连着派发出去的几条都拿到最新的一份（不用等失败登记的渲染）。
   */
  const failQueuedSendRef = useRef(failQueuedSend);
  useEffect(() => {
    failQueuedSendRef.current = failQueuedSend;
  }, [failQueuedSend]);
  const sendToTab = useCallback(
    async (
      tabId: string,
      text: string,
      expect?: { backend?: HarnessBackend; cwd?: string },
      images?: readonly PendingImage[],
      mode: PendingMode = 'steer',
      onError?: (message: string) => void,
      imageOnly?: boolean,
    ): Promise<boolean> => {
      if (tabId === MAIN_TAB_ID) return false;
      const tab = stateRef.current?.tabs.find((t) => t.id === tabId);
      if (!tab) return false;
      if (expect?.backend !== undefined && tab.backend !== expect.backend) return false;
      if (expect?.cwd !== undefined && tab.cwd !== expect.cwd) return false;
      if (tab.status === 'running' || tab.status === 'queued' || dispatching.current.has(tabId)) {
        ensureTabStore(tab);
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
          ...(hasImages
            ? { images: [...images], ...(imageOnly ? { imageOnly: true as const } : {}) }
            : {}),
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
      // 失败时只有条目仍在队列里才重记原因（等待期间已被删 / 撤回则绝不复活）
      const commit = (err: string | null): void => {
        if (err && replaceId) {
          parkedTabs.current.delete(tabId);
          const stillQueued = (queuesRef.current[tabId] ?? []).some((i) => i.id === replaceId);
          if (stillQueued) failQueuedSend(tabId, entry, err);
          else if (failRef.current[tabId]?.item.id === replaceId) clearSendError(tabId);
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
      const token = ++dispatchSeq.current;
      dispatching.current.set(tabId, token);
      let sendErr: string | null;
      try {
        sendErr = await dispatchSend(tabId, text, images);
      } catch (err) {
        sendErr = err instanceof Error ? err.message : String(err);
      } finally {
        if (dispatching.current.get(tabId) === token) {
          dispatching.current.delete(tabId);
        }
      }
      commit(sendErr);
      if (sendErr) {
        onError?.(sendErr);
        return false;
      }
      return true;
    },
    [
      stateRef,
      ensureTabStore,
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
      const head = (queuesRef.current[tabId] ?? []).find((i) => i.id === failed.item.id);
      if (!head || head.attachmentsMissing) {
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
    [sendFails, clearSendError, stateRef],
  );
  const send = useCallback(
    async (
      text: string,
      images?: readonly PendingImage[],
      mode?: PendingMode,
      onError?: (message: string) => void,
      imageOnly?: boolean,
    ) => {
      if (!isCliTab) return;
      await sendToTab(activeId, text, undefined, images, mode, onError, imageOnly);
    },
    [isCliTab, activeId, sendToTab],
  );
  const removePendingFrom = useCallback(
    (tabId: string, id: string) => {
      let removed = false;
      updateQueues((cur) => {
        const q = cur[tabId];
        if (!q?.some((i) => i.id === id)) return cur;
        removed = true;
        return { ...cur, [tabId]: q.filter((i) => i.id !== id) };
      });
      if (!removed) return;
      invalidateDispatch(tabId, id);
      if (failRef.current[tabId]?.item.id === id) clearSendError(tabId);
      resumeQueues();
    },
    [updateQueues, invalidateDispatch, clearSendError, resumeQueues],
  );
  const sendPendingTextOnly = useCallback(
    (tabId: string, id: string) => {
      const q = queuesRef.current[tabId];
      const target = q?.find((i) => i.id === id);
      if (!target || !target.attachmentsMissing || target.imageOnly || !target.text.trim()) return;
      if (failRef.current[tabId]?.item.id === id) clearSendError(tabId);
      updateQueues((cur) => {
        const list = cur[tabId];
        if (!list) return cur;
        return {
          ...cur,
          [tabId]: list.map((i) => {
            if (i.id !== id) return i;
            const { attachmentsMissing: _m, images: _imgs, imageOnly: _io, ...clean } = i;
            return clean;
          }),
        };
      });
      resumeQueues();
    },
    [clearSendError, updateQueues, resumeQueues],
  );
  const removePending = useCallback(
    (id: string) => removePendingFrom(activeId, id),
    [activeId, removePendingFrom],
  );
  /**
   * 挂回这个标签的待发列表（存在本地的 tab:<标签 id>，见 services/pendingSendsStore）：应用在回复中途重启
   * （如更新）后，重启前还没交出去的消息回来了（按「排队」），标签一开始不在运行态，队列自动发送会把它们发出去。
   * 即使当前暂无存下的数据，只要标签仍存在也提前把它的组挂进 pendingStores 以便后续入队即时落盘。
   */
  const restorePending = useCallback(
    (key: string) => {
      const tabId = key.startsWith('tab:') ? key.slice(4) : '';
      if (!tabId || tabId === MAIN_TAB_ID || pendingStores.current.has(tabId)) return false;
      const tab = stateRef.current?.tabs.find((x) => x.id === tabId);
      if (!tab || stateRef.current?.activeTabId !== tabId) return false;
      const identity = tabIdentityOf(tab);
      const store = openPendingSends({}, key, { tabIdentity: identity });
      const stored = store.read(key);
      // 这一轮已经收到了（重启时内核停得晚了一点，这一轮接着跑）：不是没发出去的话
      const sent = new Set(sentPendingTexts(stored));
      const alive = stored.filter((s) => !(s.text.trim() && sent.has(s.text.trim())));
      pendingStores.current.set(tabId, store);
      tabIdentitiesRef.current.set(tabId, identity);
      if (!alive.length) {
        if (stored.length) {
          store.save(key, []);
          void store.persist('update', []).catch(() => undefined);
        }
        return false;
      }
      store.save(key, alive);
      if (tab.status === 'running' || tab.status === 'queued')
        // 还在运行（重启后主进程恢复了这一轮）：先不塞进列表，等它结束时再说
        return false;
      const { items, restored } = mergeRestoredPending(queuesRef.current[tabId] ?? [], alive);
      updateQueues((cur) => ({ ...cur, [tabId]: items }));
      if (stored.length !== alive.length) persistTabQueue(tabId, items);
      return restored.length > 0;
    },
    [stateRef, updateQueues, persistTabQueue],
  );
  const pendingRestored = useCallback((tabId: string) => pendingStores.current.has(tabId), []);
  /**
   * 重启时标签还在跑的：先记下存下的列表，等它结束再挂回（现在挂上会被自动发送打断这一轮）。
   * 只在它真的变回空闲时做一次：这里也要求渲染时的 state 变了（后台标签的广播），且那一刻它在跑过一轮。
   */
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
      if (all.some((i) => i.attachmentsMissing)) return false;
      if (!stateRef.current?.tabs.some((t) => t.id === tabId)) return false;
      // 合成按后端图片上限分批排在最前：停下来后队列自动发送马上发出。
      // 用户明确「停止并马上发送」：原来队首的失败提示与在途派发不再算数，先失效再合并。
      invalidateDispatch(tabId);
      clearSendError(tabId);
      parkedTabs.current.delete(tabId);
      updateQueues((cur) => ({
        ...cur,
        [tabId]: mergePendingBatches(all, FLUSH_MAX_IMAGES),
      }));
      await harnessClient.cancelTab(tabId);
      return true;
    },
    [stateRef, invalidateDispatch, updateQueues, clearSendError],
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
  /** 队列自动发送一条（标签空闲）：成功才从列表移除；失败留在队首并给出可见原因（不自动重试） */
  const autoSend = useCallback(
    (tabId: string, next: PendingSend) => {
      // 锁同步打上（不等 inFlight 的渲染，也不等回执）：同一轮里 effect 再跑（流式 / StrictMode 的重复执行）
      // 也派发不了第二次；只有这一次的回执或主动取消才解除它
      const token = ++dispatchSeq.current;
      activeDispatch.current.set(tabId, { token, itemId: next.id });
      dispatching.current.set(tabId, token);
      setInFlight((cur) => ({ ...cur, [tabId]: next.id }));
      const done = () => {
        if (activeDispatch.current.get(tabId)?.token === token) {
          activeDispatch.current.delete(tabId);
        }
        if (dispatching.current.get(tabId) === token) {
          dispatching.current.delete(tabId);
        }
        setInFlight((cur) => {
          if (cur[tabId] !== next.id) return cur;
          const act = activeDispatch.current.get(tabId);
          if (act && act.token !== token) return cur;
          const copy = { ...cur };
          delete copy[tabId];
          return copy;
        });
        resumeQueues();
      };
      void dispatchSend(tabId, next.text, next.images)
        .then((err) => {
          // 若派发中途被删除 / 撤回 / 合成 / 切走，这次结果不再算数
          if (activeDispatch.current.get(tabId)?.token !== token) return;
          const stillQueued = (queuesRef.current[tabId] ?? []).some((i) => i.id === next.id);
          if (!stillQueued) return;
          if (err) {
            failQueuedSendRef.current(tabId, next, err);
            return;
          }
          updateQueues((cur) => ({
            ...cur,
            [tabId]: (cur[tabId] ?? []).filter((i) => i.id !== next.id),
          }));
          // 发出去、这一轮收到了（挂回的组跟着改：见 pendingSendsStore.settle，重启时不再次发出）
          persistTabQueue(tabId, queuesRef.current[tabId] ?? [], 'deliver');
          ackDispatch(tabId, next.id);
        })
        .catch((err: unknown) => {
          if (activeDispatch.current.get(tabId)?.token !== token) return;
          if (!(queuesRef.current[tabId] ?? []).some((i) => i.id === next.id)) return;
          failQueuedSendRef.current(tabId, next, String(err));
        })
        .finally(done);
    },
    [dispatchSend, updateQueues, persistTabQueue, resumeQueues, ackDispatch],
  );
  // 队列自动发送：标签空闲且队列非空时发出队首；已派发的标签要等它进入运行态后再继续。
  // 队首发出后先留在列表里（标成「正在发送」），内核收下（标签进入运行态）才算交付——以前先删再派发，
  // 派发在图片导入 / 预检 / 来源帧被换掉时返回错误就整条消失（正文和图片都没了）。
  useEffect(() => {
    const tabs = state?.tabs;
    if (!tabs) return;
    for (const tab of tabs) {
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
      // 重启后图片附件丢失的队首：整条队列暂停自动发送，等待用户重新附图 / 仅发文字 / 删除
      if (q[0]?.attachmentsMissing) continue;
      // 挂起的：等它开始跑这次请求（上面的运行态分支收下后才清掉标记接着发）
      if (parkedTabs.current.has(tab.id)) continue;
      if (delivering.current.has(tab.id)) continue;
      // 自动发送失败：留在队首等用户处理（重试 / 删除 / 手动发送），不自动再发。
      // 读 ref：重试刚清掉提示、渲染还没跟上时，这次开了新一轮就要派发（提示还在 register 里没提交的话会卡住）
      if (failRef.current[tab.id]) continue;
      void autoSend(tab.id, q[0]!);
    }
  }, [state, queues, inFlight, sendFails, tick, autoSend, enterRunning]);
  const dropTab = useCallback(
    (tabId: string) => {
      // 关标签：它存下的待发列表（重启后才挂回、还在等标签空闲的）不再需要，也不再让别的窗口发
      invalidateDispatch(tabId);
      clearSendError(tabId);
      parkedTabs.current.delete(tabId);
      manualRetry.current.delete(tabId);
      runningAcked.current.delete(tabId);
      tabIdentitiesRef.current.delete(tabId);
      const store = pendingStores.current.get(tabId);
      pendingStores.current.delete(tabId);
      if (store) void store.persist('clear').catch(() => undefined);
      updateQueues((cur) => {
        if (!cur[tabId]) return cur;
        const next = { ...cur };
        delete next[tabId];
        return next;
      });
    },
    [invalidateDispatch, clearSendError, updateQueues],
  );
  const hasQueued = useCallback((tabId: string) => (queuesRef.current[tabId]?.length ?? 0) > 0, []);
  return {
    queues,
    send,
    sendToTab,
    removePending,
    removePendingFrom,
    sendPendingTextOnly,
    flushPending,
    flushPendingFor,
    sendFails,
    retryFailedSend,
    inFlight,
    clearSendError,
    restorePending,
    pendingRestored,
    dropTab,
    hasQueued,
    deliverSteer,
  };
}
