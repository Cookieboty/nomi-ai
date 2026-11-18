import { byCli } from '@nomi-ai/cli-catalog';
/**
 * 开发模式侧栏的「agent 历史会话」：每个端点各自分页（20 条 / 页，「加载更多」），
 * 最多展示最近 100 条，数据来自主进程对本机 CLI 会话文件的增量扫描。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  HISTORY_BACKENDS,
  historyClient,
  type HistoryBackend,
  type HistorySession,
} from '../services/historyClient';

interface EndpointState {
  items: HistorySession[];
  nextOffset: number | null;
  hasMore: boolean;
  loading: boolean;
}

/** 按 key 去重，保留 updatedAt 最新的一条（防御：数据层按理已去重，但 React key 必须唯一） */
export function dedupeHistory(list: readonly HistorySession[]): HistorySession[] {
  const best = new Map<string, HistorySession>();
  for (const x of list) {
    const cur = best.get(x.key);
    if (!cur || x.updatedAt > cur.updatedAt) best.set(x.key, x);
  }
  // 保持首次出现的顺序
  const seen = new Set<string>();
  const out: HistorySession[] = [];
  for (const x of list) {
    if (seen.has(x.key)) continue;
    seen.add(x.key);
    out.push(best.get(x.key)!);
  }
  return out;
}

const EMPTY: EndpointState = { items: [], nextOffset: null, hasMore: false, loading: false };

/** 主进程每页条数（kernel 的 HistoryPageSize，limit 会被它封顶） */
const HISTORY_PAGE_SIZE = 20;

export interface CliHistory {
  available: boolean;
  loading: boolean;
  loaded: boolean;
  items: (b?: HistoryBackend) => HistorySession[];
  hasMore: (b?: HistoryBackend) => boolean;
  loadMore: (b?: HistoryBackend) => void;
  refresh: () => void;
}

/**
 * @param enabled   只在开发模式扫描
 * @param backends  已安装的端点
 * @param version   变化时重新拉取（例如标签集合变了，已打开的会话要从历史里消失）
 */
export function useCliHistory(
  enabled: boolean,
  backends: readonly HistoryBackend[],
  version: unknown,
): CliHistory {
  const available = historyClient.available();
  const [state, setState] = useState<Record<HistoryBackend, EndpointState>>(() =>
    byCli(() => EMPTY),
  );
  const [loaded, setLoaded] = useState(false);
  const seq = useRef(0);
  /** 最新 state（focus 回调里读，不用重建监听） */
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const key = backends.join(',');
  const active = useMemo(
    () => HISTORY_BACKENDS.filter((b) => backends.includes(b)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const patch = useCallback((b: HistoryBackend, p: Partial<EndpointState>) => {
    setState((s) => ({ ...s, [b]: { ...s[b], ...p } }));
  }, []);

  const load = useCallback(
    (list: readonly HistoryBackend[], force: boolean) => {
      const my = ++seq.current;
      for (const b of list) patch(b, { loading: true });
      void Promise.all(
        list.map(async (b) => {
          try {
            const page = await historyClient.list(b, { force });
            if (my !== seq.current) return;
            patch(b, {
              items: dedupeHistory(page?.items ?? []),
              nextOffset: page?.nextOffset ?? null,
              hasMore: !!page?.hasMore,
              loading: false,
            });
          } catch {
            if (my === seq.current) patch(b, { loading: false });
          }
        }),
      ).then(() => {
        if (my === seq.current) setLoaded(true);
      });
    },
    [patch],
  );

  useEffect(() => {
    if (!available || !enabled) return;
    const id = window.setTimeout(() => load(active, false), 120);
    return () => window.clearTimeout(id);
  }, [available, enabled, active, version, load]);

  useEffect(() => {
    if (!available || !enabled) return;
    const onFocus = () => {
      // 已经点过「加载更多」的列表不因为窗口失焦 / 聚焦被打回第一页（那会让用户觉得点了没反应）：
      // 只有还在第一页时才真正刷新
      const expanded = active.some((b) => stateRef.current[b].items.length > HISTORY_PAGE_SIZE);
      if (!expanded) load(active, true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [available, enabled, active, load]);

  const loadMore = useCallback(
    (b?: HistoryBackend) => {
      const my = seq.current;
      for (const ep of b ? [b] : active) {
        const cur = state[ep];
        if (!cur.hasMore || cur.nextOffset == null || cur.loading) continue;
        patch(ep, { loading: true });
        void historyClient
          .list(ep, { offset: cur.nextOffset })
          .then((page) => {
            if (my !== seq.current) {
              // 期间发生过整页重载：这一页丢弃，但必须解锁，否则按钮一直 disabled =「点了没反应」
              patch(ep, { loading: false });
              return;
            }
            setState((s) => ({
              ...s,
              [ep]: {
                items: dedupeHistory([...s[ep].items, ...(page?.items ?? [])]),
                nextOffset: page?.nextOffset ?? null,
                hasMore: !!page?.hasMore,
                loading: false,
              },
            }));
          })
          .catch(() => patch(ep, { loading: false }));
      }
    },
    [active, state, patch],
  );

  const items = useCallback(
    (b?: HistoryBackend) => {
      const src = b ? state[b].items : active.flatMap((x) => state[x].items);
      return b ? src : dedupeHistory([...src].sort((x, y) => y.updatedAt - x.updatedAt));
    },
    [state, active],
  );
  const hasMore = useCallback(
    (b?: HistoryBackend) => (b ? state[b].hasMore : active.some((x) => state[x].hasMore)),
    [state, active],
  );

  return {
    available,
    loading: active.some((b) => state[b].loading),
    loaded,
    items,
    hasMore,
    loadMore,
    refresh: () => load(active, true),
  };
}
