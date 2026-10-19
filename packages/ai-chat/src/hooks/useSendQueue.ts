/**
 * 发送队列：忙碌时把消息排队，空闲后按顺序自动发送（Nomi 主对话用；编程助手标签的队列在 HarnessTabsContext 里按标签维护）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** 入队时冻结的发送意图：之后切换模式不改变已排队消息的去向 */
export interface QueueOpts {
  /** 知识库问答：出队时走 askKnowledge 而不是普通对话 */
  kb?: boolean;
}

interface QueueItem {
  text: string;
  opts?: QueueOpts;
}

export function useSendQueue(
  busy: boolean,
  send: (text: string, opts?: QueueOpts) => void | Promise<void>,
  /** 变化时清空队列（如切换了会话） */
  resetKey?: string,
) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const queue = useMemo(() => items.map((i) => i.text), [items]);
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);
  /** 已派发但还没观察到进入忙碌态：防止状态更新前重复派发 */
  const inflight = useRef(false);
  const [tick, setTick] = useState(0);

  // 变化时清空队列：使用 React 官方 setState-during-render 模式（避免 effect 内 setState 的级联渲染）
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    if (items.length) setItems([]);
  }

  useEffect(() => {
    if (busy) {
      inflight.current = false;
      return;
    }
    if (!items.length || inflight.current) return;
    inflight.current = true;
    const [next, ...rest] = items;
    setItems(rest);
    void Promise.resolve(sendRef.current(next!.text, next!.opts)).finally(() => {
      inflight.current = false;
      setTick((n) => n + 1);
    });
  }, [busy, items, tick]);

  const enqueue = useCallback(
    (text: string, opts?: QueueOpts) =>
      setItems((q) => [...q, { text, ...(opts ? { opts } : {}) }]),
    [],
  );
  const remove = useCallback((i: number) => setItems((q) => q.filter((_, k) => k !== i)), []);
  return { queue, enqueue, remove };
}
