/**
 * Nomi 主对话的待发列表（agent 标签的在 HarnessTabsContext 里按标签维护），规则见 utils/pendingSends：
 * - 插入（steer）：等到安全点交给这一轮（下一个工具开始，或入列时正好有工具在跑）；交不出去改为排队；
 * - 排队（queue）：空闲后按顺序自动发送；这一轮结束时还没交出去的插入消息也照此发出；
 * - flush（Esc）：停止这一轮，把整个列表合成一条马上发出。
 * 列表同时存进会话（services/pendingSendsStore）：应用在这一轮中途重启（如更新）后恢复，不悄悄丢；
 * 交出去 / 删除 / 撤回 / 合成之后同步改存下的那份。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  mergeRestoredPending,
  storedPendingSends,
  type PendingSendStore,
  type StoredPendingSend,
} from '../services/pendingSendsStore';
import {
  mergePending,
  mergePendingKey,
  newPendingId,
  requeue,
  takeSteer,
  type PendingMode,
  type PendingSend,
} from '../utils/pendingSends';

/** 入队时冻结的发送意图：之后切换模式不改变已排队消息的去向 */
export interface QueueOpts {
  /** 知识库问答：出队时走 askKnowledge 而不是普通对话 */
  kb?: boolean;
  /** Enter = 插入（默认），Ctrl+Enter = 排队 */
  mode?: PendingMode;
}

/** 插入这一轮的通道（没有 = 只能排队） */
export interface SteerChannel {
  /** 交给进行中的这一轮；false = 交不出去 */
  deliver: (text: string) => Promise<boolean>;
  /** 现在有没结束的工具调用 */
  toolRunning: () => boolean;
  /** 工具开始时通知；返回取消函数 */
  onToolStart: (fn: () => void) => () => void;
  /** 停止这一轮 */
  stop: () => void;
}

/** 把存的（启动前的 / 内核里已有的）和当前列表合并，去掉重复 */
export function mergeStored(
  items: readonly PendingSend[],
  stored: readonly StoredPendingSend[],
): PendingSend[] {
  return mergeRestoredPending(items, stored).items;
}

/** 写存下的待发列表的原因（见 pendingSendsStore） */
export type PersistWhy = 'read' | 'update' | 'deliver' | 'unload';

export function useSendQueue(
  busy: boolean,
  send: (text: string, opts?: QueueOpts) => void | Promise<void>,
  /** 变化时清空队列（如切换了会话）；同时用来找这个会话存下的待发列表 */
  resetKey?: string,
  steer?: SteerChannel,
  /** 存下的那份（没有 = 只在内存里） */
  store?: PendingSendStore,
) {
  const [items, setItems] = useState<PendingSend[]>(() =>
    mergeStored([], store?.read(resetKey) ?? []),
  );
  const itemsRef = useRef(items);
  const sendRef = useRef(send);
  const steerRef = useRef(steer);
  /** 这个会话存下的那份（持久化只写它） */
  const keyRef = useRef(resetKey);
  const storeRef = useRef(store);
  /**
   * 存下的那份变了（读回 / 交付 / 合成 / 卸下）：换一种写法再写一次（见 pendingSendsStore）。
   * 同步结果（测试 / 浏览器预览）就地吞掉；写失败也不挡发送（下一次改再写）
   */
  const persistNow = useCallback(async (why: PersistWhy = 'update'): Promise<void> => {
    try {
      await storeRef.current?.persist(why, itemsRef.current);
    } catch {
      /* 写失败不挡发送：下一次改再写 */
    }
  }, []);
  sendRef.current = send;
  steerRef.current = steer;
  /** 换成另一个会话 / 标签的组（第一次挂上也算）时读回：内核（或本地）里存下的那份并进当前列表 */
  const adoptStore = useCallback((next: PendingSendStore | undefined) => {
    if (!next) return;
    const restored = mergeStored(itemsRef.current, next.read(keyRef.current));
    storeRef.current = next;
    if (restored.length !== itemsRef.current.length) {
      itemsRef.current = restored;
      setItems(restored);
    }
    next.save(keyRef.current, itemsRef.current);
    void next.persist('read', itemsRef.current).catch(() => undefined);
  }, []);
  useEffect(() => {
    adoptStore(store);
  }, [adoptStore, store]);
  // 已存的那份和界面上的对不上（打开时读到的是当时记下的那份）：再写一次（不新建标记，只同步）
  useEffect(() => {
    if (store) void persistNow('update');
  }, [persistNow, store]);
  /** 队列代次：resetKey 每变一次（切换会话）加一。交付期间切走过（含 A→B→A），交不出去的消息不再回到队列（#254） */
  const queueGen = useRef(0);
  useEffect(() => {
    queueGen.current += 1;
  }, [resetKey]);
  /** 已派发但还没观察到进入忙碌态：防止状态更新前重复派发 */
  const inflight = useRef(false);
  /** 正在交付的插入消息（交付期间不重复交） */
  const delivering = useRef(false);
  const [tick, setTick] = useState(0);

  // 先把改过的列表记进 ref，再渲染：交付判断读最新值，不等渲染
  const commit = useCallback((next: PendingSend[], save = true) => {
    itemsRef.current = next;
    setItems(next);
    if (save) storeRef.current?.save(keyRef.current, next);
  }, []);

  // 变化时清空队列：使用 React 官方 setState-during-render 模式（避免 effect 内 setState 的级联渲染）。
  // 切换会话只清界面上的（别的会话存下的不动）：新的组挂上（store 换了）后再读回它自己存下的那份
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    if (keyRef.current !== resetKey) {
      keyRef.current = resetKey;
      itemsRef.current = [];
      if (items.length) setItems([]);
    }
  }

  /** 把列表里的插入消息合成一条交给这一轮；交不出去的改为排队 */
  const deliver = useCallback(async () => {
    const ch = steerRef.current;
    if (!ch || delivering.current) return;
    const { steer: picked } = takeSteer(itemsRef.current);
    if (!picked.length) return;
    delivering.current = true;
    const owner = queueGen.current;
    const ids = new Set(picked.map((i) => i.id));
    commit(
      itemsRef.current.filter((i) => !ids.has(i.id)),
      false,
    );
    try {
      const ok = await ch.deliver(mergePending(picked));
      // 交不出去改为排队，但只在还是原来那个会话时：切走时队列本来就清空（resetKey），
      // 迟到的失败不能把原会话的消息放进新会话再自动发出去
      if (!ok && queueGen.current === owner) commit(requeue(itemsRef.current, picked), false);
    } finally {
      delivering.current = false;
      // 交出去了 / 交不出去改排队：存下的那份跟着改（和「这一轮收到了」那份一起存，见 pendingSendsStore）
      storeRef.current?.save(keyRef.current, itemsRef.current);
      void persistNow(queueGen.current === owner ? 'deliver' : 'update');
    }
  }, [commit, persistNow]);

  // 工具开始：交付等着的插入消息
  useEffect(() => {
    if (!steer) return;
    return steer.onToolStart(() => void deliver());
  }, [steer, deliver]);

  useEffect(() => {
    if (busy) {
      inflight.current = false;
      return;
    }
    if (!items.length || inflight.current || delivering.current) return;
    inflight.current = true;
    const [next, ...rest] = items;
    // 自动发出的：存下的那份去掉它，并记下「这一轮收到了」（见 pendingSendsStore.settle）
    commit(rest);
    void persistNow('deliver');
    void Promise.resolve(sendRef.current(next!.text, next!.kb ? { kb: true } : undefined)).finally(
      () => {
        inflight.current = false;
        setTick((n) => n + 1);
      },
    );
  }, [busy, items, tick, commit, persistNow]);

  const enqueue = useCallback(
    (text: string, opts?: QueueOpts) => {
      const mode: PendingMode = opts?.mode === 'queue' || !steerRef.current ? 'queue' : 'steer';
      const item: PendingSend = {
        id: newPendingId(),
        text,
        mode,
        ...(opts?.kb ? { kb: true } : {}),
      };
      commit([...itemsRef.current, item]);
      void persistNow('update');
      // 正好有工具在跑：现在交出去，这个工具的结果回给模型时一起带上
      if (mode === 'steer' && steerRef.current?.toolRunning()) void deliver();
    },
    [deliver, commit, persistNow],
  );
  const remove = useCallback(
    (id: string) => {
      if (!itemsRef.current.some((i) => i.id === id)) return;
      commit(itemsRef.current.filter((i) => i.id !== id));
      void persistNow('update');
    },
    [commit, persistNow],
  );
  /** Esc：停止这一轮，整个列表合成一条，停下后马上发出 */
  const flush = useCallback(() => {
    const all = itemsRef.current;
    if (!all.length) return false;
    const merged: PendingSend = {
      id: mergePendingKey(all),
      text: mergePending(all),
      mode: 'queue',
      ...(all.some((i) => i.kb) ? { kb: true } : {}),
    };
    commit([merged]);
    void persistNow('update');
    steerRef.current?.stop();
    return true;
  }, [commit, persistNow]);
  // 卸下（关窗口 / 换会话前重建）：存下的那份按界面此刻的写（再写一次，读回或交付途中丢失的补上）
  // 之后再换这个组件时（新的一个）按组键读回
  const unload = useCallback(() => void persistNow('unload'), [persistNow]);
  useEffect(() => unload, [unload]);
  return { items, enqueue, remove, flush, unload };
}
