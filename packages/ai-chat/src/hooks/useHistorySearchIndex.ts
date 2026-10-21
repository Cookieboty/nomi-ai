/**
 * 侧栏搜索用的「磁盘历史会话索引」：搜索激活后先取第一页（20 条），
 * 之后由「搜索更早的历史」按钮逐页加载，每端最多索引最近 100 条。
 * 数据在主进程里是增量解析的（只重读变化的文件），界面只做防抖后的内存过滤，不整盘扫描。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  HISTORY_BACKENDS,
  HISTORY_MAX_ITEMS,
  HISTORY_PAGE_SIZE,
  historyClient,
  type HistoryBackend,
  type HistorySession,
} from '../services/historyClient';

/** 每端最多索引最近 100 条（与后端硬上限一致），避免一次解析过多会话 */
const MAX_INDEX_PER_BACKEND = HISTORY_MAX_ITEMS;
/** 搜索结果渲染上限：最多展示 100 条 */
export const MAX_RESULTS = HISTORY_MAX_ITEMS;

interface Slot {
  items: HistorySession[];
  next: number | null;
  done: boolean;
}
const empty = (): Record<HistoryBackend, Slot> => ({
  claude: { items: [], next: 0, done: false },
  codex: { items: [], next: 0, done: false },
  dsh: { items: [], next: 0, done: false },
  gemini: { items: [], next: 0, done: false },
  grok: { items: [], next: 0, done: false },
});

export interface HistorySearchIndex {
  items: HistorySession[];
  loading: boolean;
  /** 还有更早的历史没取 */
  hasMore: boolean;
  more: () => void;
}

export function useHistorySearchIndex(
  enabled: boolean,
  backends: readonly HistoryBackend[],
  version: unknown,
): HistorySearchIndex {
  const [slots, setSlots] = useState<Record<HistoryBackend, Slot>>(empty);
  const [loading, setLoading] = useState(false);
  /** 第一页是否已取回（之前显示 loading，且「更早的历史」按钮不出现） */
  const [ready, setReady] = useState(false);
  const seq = useRef(0);
  const slotsRef = useRef(slots);
  // 把最新 slots 同步到 ref（供异步 fetchPage / more 读取）。布局 effect 在
  // 新一轮搜索的请求 effect 之前运行，避免旧请求看到半重置的状态。
  useLayoutEffect(() => {
    slotsRef.current = slots;
  }, [slots]);
  const key = backends.join(',');

  const runKey = enabled && historyClient.available() ? `${key}\u0001${String(version)}` : null;
  // 搜索参数变化时，渲染期同步重置到初始态，避免旧结果在新请求开始前短暂显示。
  const [prevRunKey, setPrevRunKey] = useState<string | null>(null);
  if (prevRunKey !== runKey) {
    setPrevRunKey(runKey);
    const fresh = empty();
    setSlots(fresh);
    setReady(false);
    setLoading(Boolean(runKey));
  }

  // 布局阶段取消旧请求并重置 ref，再让 passive effect 发起新请求。这样旧请求即使
  // 在切换搜索词后完成，也不会写回新一轮索引。
  useLayoutEffect(() => {
    const fresh = empty();
    seq.current++;
    slotsRef.current = fresh;
  }, [runKey]);

  // 取一页（force 仅用于搜索开始时的第一页刷新）；累计到 100 条硬上限即收尾
  const fetchPage = useCallback(async (b: HistoryBackend, my: number, force: boolean) => {
    const slot = slotsRef.current[b];
    if (slot.done) return;
    const page = await historyClient.index(b, {
      offset: slot.next ?? 0,
      limit: HISTORY_PAGE_SIZE,
      force,
    });
    if (my !== seq.current) return;
    const items = [...slot.items, ...(page?.items ?? [])];
    const reachedCap = items.length >= MAX_INDEX_PER_BACKEND;
    const next = !reachedCap && page?.hasMore ? (page.nextOffset ?? null) : null;
    const nextSlot: Slot = { items, next, done: next === null };
    slotsRef.current = { ...slotsRef.current, [b]: nextSlot };
    setSlots((s) => ({ ...s, [b]: nextSlot }));
  }, []);

  useEffect(() => {
    if (!enabled || !historyClient.available()) return;
    const my = ++seq.current;
    void Promise.all(
      HISTORY_BACKENDS.filter((b) => backends.includes(b)).map((b) =>
        fetchPage(b, my, true).catch(() => undefined),
      ),
    ).finally(() => {
      if (my === seq.current) {
        setLoading(false);
        setReady(true);
      }
    });
    const seqAtMount = seq;
    return () => {
      seqAtMount.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, version, fetchPage]);

  const more = useCallback(() => {
    const my = ++seq.current;
    setLoading(true);
    void Promise.all(
      HISTORY_BACKENDS.filter((b) => backends.includes(b) && !slotsRef.current[b].done).map((b) =>
        fetchPage(b, my, false).catch(() => undefined),
      ),
    ).finally(() => {
      if (my === seq.current) setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fetchPage]);

  const items = useMemo(
    () => HISTORY_BACKENDS.filter((b) => backends.includes(b)).flatMap((b) => slots[b].items),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slots, key],
  );
  const hasMore = ready && HISTORY_BACKENDS.some((b) => backends.includes(b) && !slots[b].done);
  return { items, loading: enabled && (loading || !ready), hasMore, more };
}
