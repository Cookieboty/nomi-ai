import { t } from '@nomi-ai/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { isNomiDelegated } from '../../services/harnessClient';
import type { HistoryBackend, HistorySession } from '../../services/historyClient';
import type { ConversationBackend } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';

import type { Meta } from './types';

type Tabs = ReturnType<typeof useHarnessTabs>;

interface SidebarEndpointsOptions {
  tabs: Tabs;
  navList: Meta[];
  highlightId: string | undefined;
  endpointFilter: ConversationBackend;
  setEndpointFilter: (b: ConversationBackend) => void;
  setView: (v: 'all' | 'by-endpoint') => void;
  counts: Record<ConversationBackend, number>;
  tabById: Map<string, { status?: string; projectId?: string }>;
  histBackends: readonly HistoryBackend[];
  historyItems: (backend?: HistoryBackend) => HistorySession[];
  cliMissing: (b: ConversationBackend) => boolean;
  open: (id: string) => void;
  createFor: (b: ConversationBackend, projectId?: string | null) => void | Promise<void>;
  onLeavePage?: () => void;
}

/**
 * 左下角信息卡的端点选择与端点图标的悬停提示：「按端」筛选、切端时打开该端最近活动的会话。
 */
export function useSidebarEndpoints({
  tabs,
  navList,
  highlightId,
  endpointFilter,
  setEndpointFilter,
  setView,
  counts,
  tabById,
  histBackends,
  historyItems,
  cliMissing,
  open,
  createFor,
  onLeavePage,
}: SidebarEndpointsOptions) {
  // 左下角信息卡跟随当前会话所在的端（CLI 标签 / Nomi 对话）；点了顶部端点图标就先看那个端，
  // 直到切换会话。还没有当前会话时退回筛选的端
  const [cardPick, setCardPick] = useState<ConversationBackend | null>(null);
  const [cardPickFor, setCardPickFor] = useState(highlightId);
  if (cardPickFor !== highlightId) {
    setCardPickFor(highlightId);
    setCardPick(null);
  }
  const cardBackend: ConversationBackend =
    cardPick ?? navList.find((x) => x.id === highlightId)?.backend ?? endpointFilter;

  // 该端的运行中 / 排队中标签数与最近一次标签活动（信息卡用）
  const { endpointRunning, endpointLastTab } = useMemo(() => {
    let running = 0;
    let last: number | null = null;
    for (const x of tabs.state?.tabs ?? []) {
      if (x.backend !== cardBackend || isNomiDelegated(x)) continue;
      if (x.status === 'running' || x.status === 'queued') running++;
      if (last == null || x.updatedAt > last) last = x.updatedAt;
    }
    return { endpointRunning: running, endpointLastTab: last };
  }, [tabs.state, cardBackend]);

  const pickEndpoint = (b: ConversationBackend) => {
    onLeavePage?.();
    setCardPick(b);
    setEndpointFilter(b);
    setView('by-endpoint');
    // 切到另一个端：打开它正在运行（或排队）的会话；没有就打开列表里第一条；一条都没有就新建一个空对话
    // （没安装的 CLI 只切筛选），并衔接当前高亮会话所在项目。已经停在这个端的会话上就不动
    const curMeta = navList.find((x) => x.id === highlightId);
    if (curMeta?.backend === b) return;
    const curProjectId = curMeta
      ? (curMeta.projectId ?? (curMeta.tabId ? tabById.get(curMeta.tabId)?.projectId : undefined))
      : undefined;
    const items = navList.filter((x) => x.backend === b);
    const busy = (x: (typeof items)[number]) => {
      const st = x.tabId ? tabById.get(x.tabId)?.status : undefined;
      return st === 'running' || st === 'queued';
    };
    const target = items.find(busy) ?? items[0];
    if (target) void open(target.id);
    else if (!cliMissing(b)) void createFor(b, curProjectId);
  };

  // 端点图标的悬停提示：名称 + 对话数 + 本机历史数（只列非 0 的）
  const endpointTip = (b: ConversationBackend): string => {
    const hist = (histBackends as readonly string[]).includes(b)
      ? historyItems(b as HistoryBackend).length
      : 0;
    return [
      ENDPOINT_FULL[b](),
      counts[b] ? t('ui.cli-monitor.conversations', counts[b]) : '',
      hist ? t('ui.cli-monitor.local-sessions', hist) : '',
      cliMissing(b) ? t('ui.mascot-theme.not-installed') : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };

  return { cardBackend, endpointRunning, endpointLastTab, pickEndpoint, endpointTip };
}

interface ModeRedirectOptions {
  isDev: boolean;
  list: Meta[];
  current: string | undefined;
  open: (id: string) => Promise<void>;
  createFor: (b: ConversationBackend) => Promise<void>;
}

/**
 * 模式切换：普通模式下当前会话若是 CLI 会话，自动换到最近的 Nomi 会话（没有则新建）；
 * 切回开发模式时回到离开前选中的会话。CLI 标签一直在后台运行。
 */
export function useModeRedirect({ isDev, list, current, open, createFor }: ModeRedirectOptions) {
  const leftDevOn = useRef<string | null>(null);
  const redirecting = useRef(false);
  const currentMeta = list.find((x) => x.id === current);
  useEffect(() => {
    if (isDev) {
      const back = leftDevOn.current;
      leftDevOn.current = null;
      if (back && back !== current && list.some((x) => x.id === back)) void open(back);
      return;
    }
    if (!currentMeta || currentMeta.backend === 'nomi' || redirecting.current || !list.length)
      return;
    redirecting.current = true;
    leftDevOn.current = currentMeta.id;
    const nomi = list.find((x) => x.backend === 'nomi');
    // 一次性的模式切换重定向（受 redirecting 保护），不会级联渲染

    void Promise.resolve(nomi ? open(nomi.id) : createFor('nomi')).finally(() => {
      redirecting.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDev, currentMeta?.id, currentMeta?.backend, list.length]);
}
