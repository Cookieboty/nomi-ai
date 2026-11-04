/**
 * Nomi 主对话的待发列表（编程助手标签的在 HarnessTabsContext 里按标签维护），规则见 utils/pendingSends：
 * - 插入（steer）：等到安全点交给这一轮（下一个工具开始，或入列时正好有工具在跑）；交不出去改为排队；
 * - 排队（queue）：空闲后按顺序自动发送；这一轮结束时还没交出去的插入消息也照此发出；
 * - flush（Esc）：停止这一轮，把整个列表合成一条马上发出。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  mergePending,
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

export function useSendQueue(
  busy: boolean,
  send: (text: string, opts?: QueueOpts) => void | Promise<void>,
  /** 变化时清空队列（如切换了会话） */
  resetKey?: string,
  steer?: SteerChannel,
) {
  const [items, setItems] = useState<PendingSend[]>([]);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const sendRef = useRef(send);
  const steerRef = useRef(steer);
  useEffect(() => {
    sendRef.current = send;
    steerRef.current = steer;
  }, [send, steer]);
  /** 已派发但还没观察到进入忙碌态：防止状态更新前重复派发 */
  const inflight = useRef(false);
  /** 正在交付的插入消息（交付期间不重复交） */
  const delivering = useRef(false);
  const [tick, setTick] = useState(0);

  // 变化时清空队列：使用 React 官方 setState-during-render 模式（避免 effect 内 setState 的级联渲染）
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    if (items.length) setItems([]);
  }

  /** 把列表里的插入消息合成一条交给这一轮；交不出去的改为排队 */
  const deliver = useCallback(async () => {
    const ch = steerRef.current;
    if (!ch || delivering.current) return;
    const { steer: picked } = takeSteer(itemsRef.current);
    if (!picked.length) return;
    delivering.current = true;
    const ids = new Set(picked.map((i) => i.id));
    setItems((cur) => cur.filter((i) => !ids.has(i.id)));
    try {
      const ok = await ch.deliver(mergePending(picked));
      if (!ok) setItems((cur) => requeue(cur, picked));
    } finally {
      delivering.current = false;
    }
  }, []);

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
    setItems(rest);
    void Promise.resolve(sendRef.current(next!.text, next!.kb ? { kb: true } : undefined)).finally(
      () => {
        inflight.current = false;
        setTick((n) => n + 1);
      },
    );
  }, [busy, items, tick]);

  const enqueue = useCallback(
    (text: string, opts?: QueueOpts) => {
      const mode: PendingMode = opts?.mode === 'queue' || !steerRef.current ? 'queue' : 'steer';
      const item: PendingSend = {
        id: newPendingId(),
        text,
        mode,
        ...(opts?.kb ? { kb: true } : {}),
      };
      itemsRef.current = [...itemsRef.current, item];
      setItems(itemsRef.current);
      // 正好有工具在跑：现在交出去，这个工具的结果回给模型时一起带上
      if (mode === 'steer' && steerRef.current?.toolRunning()) void deliver();
    },
    [deliver],
  );
  const remove = useCallback((id: string) => setItems((q) => q.filter((i) => i.id !== id)), []);
  /** Esc：停止这一轮，整个列表合成一条，停下后马上发出 */
  const flush = useCallback(() => {
    const all = itemsRef.current;
    if (!all.length) return false;
    const merged: PendingSend = {
      id: newPendingId(),
      text: mergePending(all),
      mode: 'queue',
      ...(all.some((i) => i.kb) ? { kb: true } : {}),
    };
    itemsRef.current = [merged];
    setItems(itemsRef.current);
    steerRef.current?.stop();
    return true;
  }, []);
  return { items, enqueue, remove, flush };
}
