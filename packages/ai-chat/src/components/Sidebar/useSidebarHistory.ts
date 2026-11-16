import { useCallback, useMemo } from 'react';

import type { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useCliHistory } from '../../hooks/useCliHistory';
import {
  orderEndpoints,
  visibleEndpoints,
  type ConversationListView,
  type EndpointVisibilityMap,
} from '../../services/chatPrefs';
import { MAIN_TAB_ID } from '../../services/harnessClient';
import {
  HISTORY_BACKENDS,
  type HistoryBackend,
  type HistorySession,
} from '../../services/historyClient';
import { CONVERSATION_BACKENDS, type ConversationBackend } from '../../types/chat';

import type { Meta } from './types';

type Tabs = ReturnType<typeof useHarnessTabs>;

interface SidebarHistoryOptions {
  isDev: boolean;
  list: Meta[];
  bins: Record<string, string | null>;
  tabs: Tabs;
  view: ConversationListView;
  endpointFilter: ConversationBackend;
  endpointVisibility: EndpointVisibilityMap;
  endpointOrder: readonly ConversationBackend[] | null;
  counts: Record<ConversationBackend, number>;
}

/**
 * 侧栏的本机历史与端点活动：磁盘历史、已打开会话键、历史过滤与端点机关顺序的派生都在这里。
 */
export function useSidebarHistory({
  isDev,
  list,
  bins,
  tabs,
  view,
  endpointFilter,
  endpointVisibility,
  endpointOrder,
  counts,
}: SidebarHistoryOptions) {
  // 开发模式：磁盘上的 CLI 历史会话（每端 50 条一页）
  const histBackends = useMemo(() => HISTORY_BACKENDS.filter((b) => Boolean(bins[b])), [bins]);
  const tabsKey = (tabs.state?.tabs ?? []).map((x) => `${x.id}:${x.cliSessionId ?? ''}`).join('|');
  const history = useCliHistory(isDev, histBackends, tabsKey);

  // 镜像条目与本机历史使用同一个稳定键：CLI 后端 + 原生会话 id。
  // 主进程会尽量提前排除已打开的会话，但这里还要防住历史扫描与标签同步的竞态，
  // 也要覆盖搜索索引返回得比侧栏列表更早的情况。
  const openSessionKeys = useMemo(() => {
    const keys = new Set(
      list.filter((c) => c.tabId && c.cliSessionId).map((c) => `${c.backend}:${c.cliSessionId}`),
    );
    // 标签状态先于 ConversationStore 镜像到达时，也要立即隐藏本机历史。
    for (const tab of tabs.state?.tabs ?? []) {
      if (tab.id !== MAIN_TAB_ID && tab.cliSessionId)
        keys.add(`${tab.backend}:${tab.cliSessionId}`);
    }
    return keys;
  }, [list, tabs.state]);

  const historyItems = useCallback(
    (backend?: HistoryBackend) => history.items(backend).filter((h) => !openSessionKeys.has(h.key)),
    [history, openSessionKeys],
  );

  const histScope: HistoryBackend | undefined =
    view === 'by-endpoint' && endpointFilter !== 'nomi'
      ? (endpointFilter as HistoryBackend)
      : undefined;
  // 磁盘历史扫描由主进程按各 CLI 的本地格式完成，包含 Grok 的 updates.jsonl。
  const histScopeSupported =
    histScope === undefined || (HISTORY_BACKENDS as readonly string[]).includes(histScope);
  const histItems: HistorySession[] =
    !histScopeSupported || (view === 'by-endpoint' && endpointFilter === 'nomi')
      ? []
      : historyItems(histScope);

  // 侧栏「按端」：对话数（CLI 标签已镜像进对话列表）+ 磁盘历史；都为 0 且没有显式设置的端点不显示
  const endpointActivity = useMemo(() => {
    const a: Partial<Record<ConversationBackend, number>> = { ...counts };
    for (const b of histBackends) a[b] = (a[b] ?? 0) + historyItems(b).length;
    return a;
  }, [counts, histBackends, historyItems]);

  const shownEndpoints = useMemo(() => {
    const shown = visibleEndpoints(
      CONVERSATION_BACKENDS,
      endpointVisibility,
      endpointActivity,
      (b) => Boolean(bins[b]),
    );
    // 正在看的端点（没被显式隐藏）始终保留，避免数据还没加载完时按钮跳动
    if (!shown.includes(endpointFilter) && endpointVisibility[endpointFilter] !== 'hide')
      return CONVERSATION_BACKENDS.filter((b) => b === endpointFilter || shown.includes(b));
    return shown;
  }, [endpointVisibility, endpointActivity, endpointFilter, bins]);

  // 导航栏够高：全部端点按顺序竖排（Nomi 最前，其余按自定义顺序或对话数）
  const railEndpoints = useMemo(
    () => orderEndpoints(shownEndpoints, endpointActivity, endpointOrder),
    [shownEndpoints, endpointActivity, endpointOrder],
  );

  // 本机历史随当前筛选合在同一个列表里：Nomi 没有磁盘历史，不显示
  const histVisible =
    isDev &&
    history.available &&
    histBackends.length > 0 &&
    histScopeSupported &&
    !(view === 'by-endpoint' && endpointFilter === 'nomi');
  const histScanning = histVisible && histItems.length === 0 && history.loading && !history.loaded;

  return {
    histBackends,
    tabsKey,
    history,
    openSessionKeys,
    historyItems,
    histScope,
    histScopeSupported,
    histItems,
    endpointActivity,
    shownEndpoints,
    railEndpoints,
    histVisible,
    histScanning,
  };
}
