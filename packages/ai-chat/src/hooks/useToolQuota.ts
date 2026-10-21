/**
 * 订阅额度（每个工具独立的加载 / 失败 / 最后更新状态）。
 * - `refreshTool(id)`：只让这一个工具的官方 CLI 去取额度（IPC 参数化），不影响其他工具；
 * - `refreshAll()`：次要入口，主进程内并行刷新三个工具。
 * 用量面板的工具卡片、「按端」信息卡与详情抽屉共用这一份状态逻辑。
 * - 上一次的结果留在内存里：再次打开「订阅额度」先显示上一次的值，再在后台更新，不会先空一下。
 *   （跨重启的保留在主进程 UsageService 的 quota.json。）
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { refreshNote, type Note } from '../components/UsagePanel/quotaNote';
import {
  USAGE_QUOTA_TOOLS,
  usageClient,
  type UsageQuotaEntry,
  type UsageQuotaRefresh,
  type UsageQuotaTool,
} from '../services/usageClient';

export type CardPhase = 'idle' | 'loading' | 'ok' | 'error';

export interface ToolCardState {
  phase: CardPhase;
  note: Note | null;
  /** 这张卡最近一次点刷新完成的时间（成功或失败） */
  refreshedAt: number | null;
}

const IDLE: ToolCardState = { phase: 'idle', note: null, refreshedAt: null };

/** 上一次的显示状态（同一个窗口内跨组件挂载保留） */
const memo: {
  rows: UsageQuotaEntry[] | null;
  cards: Record<string, ToolCardState>;
  active: boolean;
} = { rows: null, cards: {}, active: true };

/** 测试用：清掉上一次的显示状态 */
export function resetToolQuotaMemo(): void {
  memo.rows = null;
  memo.cards = {};
  memo.active = true;
}

/** 卸载时还在刷新的卡片：结果回不来了，恢复时当作空闲，避免一直转圈 */
function restoredCards(): Record<string, ToolCardState> {
  const out: Record<string, ToolCardState> = {};
  for (const [id, c] of Object.entries(memo.cards))
    out[id] = c.phase === 'loading' ? { ...c, phase: 'idle' } : c;
  return out;
}

export const isQuotaTool = (id: string): id is UsageQuotaTool =>
  (USAGE_QUOTA_TOOLS as readonly string[]).includes(id);

export function useToolQuota(opts: { poll?: boolean } = {}) {
  const { poll = true } = opts;
  const [rows, setRows] = useState<UsageQuotaEntry[] | null>(() => memo.rows);
  const [cards, setCards] = useState<Record<string, ToolCardState>>(restoredCards);
  const [active, setActive] = useState(() => memo.active);
  // 记住最新的显示状态，下次挂载直接用
  useEffect(() => {
    memo.rows = rows;
  }, [rows]);
  useEffect(() => {
    memo.cards = cards;
  }, [cards]);
  useEffect(() => {
    memo.active = active;
  }, [active]);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  const patch = useCallback((id: string, p: Partial<ToolCardState>) => {
    setCards((c) => ({ ...c, [id]: { ...(c[id] ?? IDLE), ...p } }));
  }, []);

  const load = useCallback(
    () =>
      Promise.all([usageClient.quota(), usageClient.state().catch(() => null)])
        .then(([r, st]) => {
          if (!alive.current) return;
          setRows(Array.isArray(r) ? r : []);
          setNow(Date.now());
          if (st?.settings) setActive(st.settings.activeQuotaRefresh !== false);
        })
        .catch(() => {
          if (alive.current) setRows((p) => p ?? []);
        }),
    [],
  );

  useEffect(() => {
    alive.current = true;
    if (!usageClient.available()) return;
    void load();
    const off = usageClient.onChanged(() => void load());
    const timer = poll ? setInterval(() => void load(), 30_000) : null;
    return () => {
      alive.current = false;
      off();
      if (timer) clearInterval(timer);
    };
  }, [load, poll]);

  /** 只替换这个工具自己的那一行，不覆盖其他工具正在刷新的数据 */
  const mergeEntry = useCallback((id: string, r: UsageQuotaRefresh) => {
    const next = r.entries.find((e) => e.id === id);
    if (!next) return;
    setRows((prev) =>
      prev
        ? prev.some((e) => e.id === id)
          ? prev.map((e) => (e.id === id ? next : e))
          : [...prev, next]
        : r.entries,
    );
  }, []);

  const refreshTool = useCallback(
    async (id: UsageQuotaTool) => {
      patch(id, { phase: 'loading', note: null });
      try {
        const r = await usageClient.quotaRefresh(id);
        if (!alive.current) return;
        mergeEntry(id, r);
        const res = r.tools[id];
        const note = res ? refreshNote(id, res) : null;
        patch(id, {
          phase: note?.tone === 'err' ? 'error' : 'ok',
          note,
          refreshedAt: Date.now(),
        });
        setNow(Date.now());
      } catch (e) {
        if (!alive.current) return;
        patch(id, {
          phase: 'error',
          note: { tone: 'err', text: e instanceof Error ? e.message : String(e) },
          refreshedAt: Date.now(),
        });
      }
    },
    [mergeEntry, patch],
  );

  const refreshAll = useCallback(async () => {
    const ids = USAGE_QUOTA_TOOLS.filter((id) => rows?.some((e) => e.id === id) ?? true);
    for (const id of ids) patch(id, { phase: 'loading', note: null });
    try {
      const r = await usageClient.quotaRefresh();
      if (!alive.current) return;
      setRows(r.entries);
      setNow(Date.now());
      for (const id of ids) {
        const res = r.tools[id];
        const note = res ? refreshNote(id, res) : null;
        patch(id, {
          phase: note?.tone === 'err' ? 'error' : 'ok',
          note,
          refreshedAt: Date.now(),
        });
      }
    } catch (e) {
      if (!alive.current) return;
      const text = e instanceof Error ? e.message : String(e);
      for (const id of ids)
        patch(id, { phase: 'error', note: { tone: 'err', text }, refreshedAt: Date.now() });
    }
  }, [patch, rows]);

  const anyLoading = Object.values(cards).some((c) => c.phase === 'loading');

  return { rows, cards, active, now, load, refreshTool, refreshAll, anyLoading };
}
