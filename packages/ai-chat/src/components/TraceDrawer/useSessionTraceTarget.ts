/**
 * 组装当前活动会话的 TraceTarget（kind: 'session'）：
 * 统一汇总主对话消息列表、进行中直播流、委派代理与关联任务，
 * 供工作区 Tabs（TraceTab）与兜底弹窗（SessionTraceModal）复用。
 */
import { t } from '@nomi-ai/ui';
import { useMemo } from 'react';

import type { AiChatState } from '../../contexts/AiChatContext';
import { selectBusyHere, selectIpcClient, useAiChatSelector } from '../../contexts/aiChatStore';
import {
  useHarnessDetached,
  useHarnessLive,
  useHarnessTabs,
} from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import type { ConversationStore } from '../../services/conversationStore';
import type { ConvMessage } from '../../types/conversation';
import type { IPCClient } from '../../types/ipc';
import { nomiLive, sameLive } from '../../utils/convAdapters';
import { sessionTasks } from '../SessionDetails/tasks';
import { useTasks } from '../Tasks';

import type { TraceTarget } from './sessionLoader';

const selectNomiLiveFull = (s: AiChatState) => nomiLive(s.messages, selectBusyHere(s));

export function useSessionTraceTarget(
  messages: readonly ConvMessage[],
  fallbackTitle?: string,
): Extract<TraceTarget, { kind: 'session' }> {
  const tabs = useHarnessTabs();
  const { isDev } = useChatMode();
  const tabId = isDev && tabs.isCliTab ? tabs.activeTab?.id : undefined;
  const activeTabTitle = isDev && tabs.isCliTab ? tabs.activeTab?.title : undefined;
  const cliLive = useHarnessLive((l) => (tabId ? l[tabId] : undefined));
  const offTurnAgents = useHarnessDetached((l) => (tabId ? l[tabId]?.agents : undefined));
  const nomiLiveObj = useAiChatSelector(selectNomiLiveFull, sameLive);
  const ipc = useAiChatSelector(selectIpcClient) as IPCClient | undefined;
  const store = ipc?.conversationStore?.() as ConversationStore | undefined;
  const conversationId = tabId
    ? store?.list().find((c) => c.tabId === tabId)?.id
    : (ipc?.currentConversationId?.() ?? undefined);
  const { data } = useTasks(true);
  const allTasks = data?.tasks;
  const cliAgents = cliLive?.agents;
  const convMeta = conversationId ? store?.get(conversationId) : undefined;
  const title = tabId
    ? (activeTabTitle ?? fallbackTitle ?? t('ui.devtools.scope-session'))
    : convMeta?.name
      ? t(convMeta.name)
      : (fallbackTitle ?? t('ui.devtools.scope-session'));

  return useMemo(() => {
    const relatedTasks = allTasks ? sessionTasks(allTasks, conversationId) : [];
    const liveAgents =
      offTurnAgents && cliAgents
        ? { ...cliAgents, ...offTurnAgents }
        : (offTurnAgents ?? cliAgents);
    return {
      kind: 'session' as const,
      title,
      messages,
      source: tabId ? ({ kind: 'cli', tabId } as const) : ({ kind: 'nomi' } as const),
      liveTrace: tabId ? cliLive?.trace : nomiLiveObj?.trace,
      liveText: tabId ? cliLive?.text : nomiLiveObj?.text,
      liveStartedAt: tabId ? cliLive?.startedAt : nomiLiveObj?.startedAt,
      liveAgents,
      conversationId,
      relatedTasks,
    };
  }, [
    title,
    messages,
    tabId,
    cliLive?.trace,
    cliLive?.text,
    cliLive?.startedAt,
    nomiLiveObj?.trace,
    nomiLiveObj?.text,
    nomiLiveObj?.startedAt,
    offTurnAgents,
    cliAgents,
    conversationId,
    allTasks,
  ]);
}
