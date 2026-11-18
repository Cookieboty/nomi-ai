/**
 * 对话区主体：agent 标签（空标签的欢迎语 / 会话）或 Nomi 主对话（欢迎屏 / 会话）。
 * Nomi 会话里只有 NomiConversation 订阅流式的最后一轮，其余部分不随每帧重渲染。
 */
import { t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { ConversationView } from '../components/Conversation';
import { CliConversation } from '../components/Conversation/CliConversation';
import { buildCliSlots } from '../components/Conversation/cliSlots';
import { GeminiTrustAction } from '../components/Conversation/GeminiTrustAction';
import type { ConvSlots } from '../components/Conversation/Messages';
import { nomiSlots } from '../components/Conversation/nomiSlots';
import { nomiTraceSlots, traceActions } from '../components/Conversation/TraceAction';
import { ConversationWelcome } from '../components/ConversationWelcome';
import type { AiChatState } from '../contexts/AiChatContext';
import {
  selectBusyHere,
  selectFirstMessageId,
  useAiChatActions,
  useAiChatSelector,
} from '../contexts/aiChatStore';
import { useHarnessLive, type HarnessTabsCore } from '../contexts/HarnessTabsContext';
import { useLiveWithGatewayRetry } from '../hooks/useGatewayRetry';
import { useTranscriptView } from '../hooks/useTranscriptView';
import {
  CONVERSATION_NAV_DEMO_EVENT,
  conversationNavDemoMessages,
} from '../services/conversationNavDemo';
import { derivedSwitchTip } from '../services/modelSwitchTip';
import { nomiModelLabel, useGatewayState } from '../services/nomiModel';
import type { TranscriptView } from '../services/transcriptView';
import type { SlashHook } from '../slash/useSlashCommands';
import type { ConvMessage } from '../types/conversation';
import { nomiLive, sameLive } from '../utils/convAdapters';

// 回复中只看当前展示的会话：切到别的会话时，那个会话的最后一条回复不能被当成「进行中」
const selectNomiLive = (s: AiChatState) => nomiLive(s.messages, selectBusyHere(s));

/** The Nomi conversation: the only part that rerenders per streamed frame (its live turn). */
const NomiConversation: React.FC<Omit<React.ComponentProps<typeof ConversationView>, 'live'>> = (
  props,
) => {
  // 网关在重连 / 换供应商时，等待态显示原因
  const live = useLiveWithGatewayRetry(useAiChatSelector(selectNomiLive, sameLive));
  // 换了 Nomi 的模型、还没发送：和最后一条助手消息的模型比（网关状态变化时重算）
  useGatewayState();
  const current = nomiModelLabel();
  const modelSwitchTip = useMemo(
    () => derivedSwitchTip(props.messages, current),
    [props.messages, current],
  );
  return <ConversationView {...props} live={live} modelSwitchTip={modelSwitchTip} />;
};

/** 重新生成 / 重试：找到这条助手消息之前的用户消息，从那里重发 */
const precedingUser = <T extends { id: string; role: string; steer?: boolean }>(
  list: readonly T[],
  id: string,
) => {
  const i = list.findIndex((m) => m.id === id);
  // 跳过中途插入的用户消息：重试从这一轮原来的那句开始
  for (let k = i - 1; k >= 0; k--) {
    const m = list[k]!;
    if (m.role === 'user' && !m.steer) return m;
  }
  return undefined;
};

/** agent 标签：没有消息时是欢迎语，否则是会话（Gemini 不信任工作目录时错误卡片上有「信任此文件夹」） */
const CliBody: React.FC<{
  tabs: HarnessTabsCore;
  isDev: boolean;
  messages: ConvMessage[];
  slash: SlashHook;
  transcriptView: TranscriptView;
}> = ({ tabs, isDev, messages, slash, transcriptView }) => {
  const tab = tabs.activeTab!;
  const tabId = tab.id;
  const cwd = tab.cwd;
  const hasLive = useHarnessLive((l) => !!l[tabId]);
  const slots = useMemo<ConvSlots>(
    () =>
      buildCliSlots({
        cwd,
        tab,
        ...(isDev ? traceActions({ kind: 'cli', tabId }) : {}),
        errorActions: (m, { retry }) =>
          m.geminiTrust ? (
            <GeminiTrustAction key={m.id} tabId={tabId} message={m} retry={retry} />
          ) : null,
      }),
    [tabId, cwd, tab, isDev],
  );
  if (messages.length === 0 && !hasLive && slash.cards.length === 0 && tab.status === 'idle')
    return (
      <ConversationWelcome
        backend={tab.backend}
        title={t('ui.mascot-theme.new-session', tab.title)}
        description={t('ui.mascot-theme.messages-go-to-the-coding-agent-on-this')}
      />
    );
  return (
    <CliConversation
      scopeId={tabId}
      messages={messages}
      transcriptView={transcriptView}
      phase={tab.status === 'running' ? 'running' : tab.status === 'queued' ? 'queued' : 'idle'}
      slots={slots}
      cards={slash.cards}
      onDismissCard={slash.dismissCard}
      dormant={tab.dormant}
      backgroundAgents={tab.backgroundAgents}
      backgroundCount={tab.background}
    />
  );
};

/**
 * Nomi 主对话还没有消息：欢迎屏（图标 + 标题 + 小标题）。
 * 示例问题卡片与模型引导都在输入框一侧，由 App 层渲染。
 */
const NomiWelcome: React.FC = () => (
  <ConversationWelcome title={t('ui.foundation.what-would-you-like-to-do-today')} />
);

export const ChatBody: React.FC<{
  tabs: HarnessTabsCore;
  isDev: boolean;
  /** 当前会话的键（tab:… / nomi:…）；隔离滚动状态并按会话保存 Transcript view */
  sessionKey: string | null;
  cliMessages: ConvMessage[];
  nomiMessages: ConvMessage[];
  slash: SlashHook;
}> = ({ tabs, isDev, sessionKey, cliMessages, nomiMessages, slash }) => {
  const [navDemoSessionKey, setNavDemoSessionKey] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isDev) return;
    const onDemo = () => setNavDemoSessionKey(sessionKey);
    window.addEventListener(CONVERSATION_NAV_DEMO_EVENT, onDemo);
    return () => window.removeEventListener(CONVERSATION_NAV_DEMO_EVENT, onDemo);
  }, [isDev, sessionKey]);
  const navDemoMessages = useMemo(
    () =>
      navDemoSessionKey !== undefined && navDemoSessionKey === sessionKey
        ? conversationNavDemoMessages()
        : [],
    [navDemoSessionKey, sessionKey],
  );
  const displayCliMessages = useMemo(
    () =>
      navDemoMessages.length && tabs.isCliTab ? [...cliMessages, ...navDemoMessages] : cliMessages,
    [cliMessages, navDemoMessages, tabs.isCliTab],
  );
  const displayNomiMessages = useMemo(
    () =>
      navDemoMessages.length && !tabs.isCliTab
        ? [...nomiMessages, ...navDemoMessages]
        : nomiMessages,
    [nomiMessages, navDemoMessages, tabs.isCliTab],
  );
  const { view: transcriptView } = useTranscriptView(sessionKey);
  const { actions, store: chatStore } = useAiChatActions();
  const busyHere = useAiChatSelector(selectBusyHere);
  const firstMessageId = useAiChatSelector(selectFirstMessageId);
  const onRetry = useCallback(
    (id: string) => {
      const u = precedingUser(chatStore.get().messages, id);
      if (u) void actions.resendFrom(u.id);
    },
    [chatStore, actions],
  );
  const onEdit = useCallback(
    (id: string, text: string) => void actions.resendFrom(id, text),
    [actions],
  );
  if (isDev && tabs.isCliTab)
    return (
      <CliBody
        tabs={tabs}
        isDev={isDev}
        messages={displayCliMessages}
        slash={slash}
        transcriptView={transcriptView}
      />
    );
  if (displayNomiMessages.length === 0 && slash.cards.length === 0) return <NomiWelcome />;
  return (
    <NomiConversation
      scopeId={sessionKey ?? `nomi:${firstMessageId ?? 'new'}`}
      messages={displayNomiMessages}
      transcriptView={transcriptView}
      phase={busyHere ? 'running' : 'idle'}
      onRetry={onRetry}
      onEdit={onEdit}
      slots={isDev ? nomiTraceSlots : nomiSlots}
      cards={slash.cards}
      onDismissCard={slash.dismissCard}
    />
  );
};
