/**
 * 对话区主体：编程助手标签（空标签的欢迎语 / 会话）或 Nomi 主对话（欢迎屏 / 会话）。
 * Nomi 会话里只有 NomiConversation 订阅流式的最后一轮，其余部分不随每帧重渲染。
 */
import { Button, t } from '@nomi-ai/ui';
import React, { useCallback, useMemo } from 'react';

import { ConversationView } from '../components/Conversation';
import { CliConversation } from '../components/Conversation/CliConversation';
import { buildCliSlots } from '../components/Conversation/cliSlots';
import { GeminiTrustAction } from '../components/Conversation/GeminiTrustAction';
import type { ConvSlots } from '../components/Conversation/Messages';
import { nomiSlots } from '../components/Conversation/nomiSlots';
import { nomiTraceSlots, traceActions } from '../components/Conversation/TraceAction';
import { DispatchCli, type DispatchBackend } from '../components/DispatchCli';
import type { AiChatState } from '../contexts/AiChatContext';
import {
  selectBusyHere,
  selectFirstMessageId,
  selectMessageCount,
  useAiChatActions,
  useAiChatSelector,
} from '../contexts/aiChatStore';
import { useHarnessLive, type HarnessTabsCore } from '../contexts/HarnessTabsContext';
import { useChatMode } from '../hooks/useChatMode';
import { useLiveWithGatewayRetry } from '../hooks/useGatewayRetry';
import { useNomiModelStatus } from '../hooks/useNomiModelStatus';
import { useTranscriptView } from '../hooks/useTranscriptView';
import { useUserProfile } from '../hooks/useUserProfile';
import { derivedSwitchTip } from '../services/modelSwitchTip';
import { nomiModelLabel, useGatewayState } from '../services/nomiModel';
import { QUICK_PROMPT_TEXT, recommend } from '../services/recommendations';
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
const precedingUser = <T extends { id: string; role: string }>(list: readonly T[], id: string) => {
  const i = list.findIndex((m) => m.id === id);
  for (let k = i - 1; k >= 0; k--) if (list[k]!.role === 'user') return list[k]!;
  return undefined;
};

/** 编程助手标签：没有消息时是欢迎语，否则是会话（Gemini 不信任工作目录时错误卡片上有「信任此文件夹」） */
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
        ...(isDev ? traceActions({ kind: 'cli', tabId }) : {}),
        errorActions: (m, { retry }) =>
          m.geminiTrust ? (
            <GeminiTrustAction key={m.id} tabId={tabId} message={m} retry={retry} />
          ) : null,
      }),
    [tabId, cwd, isDev],
  );
  if (tabs.messages.length === 0 && !hasLive && slash.cards.length === 0 && tab.status === 'idle')
    return (
      <div className="welcome-screen" data-testid="cli-tab-empty">
        <div className="welcome-content">
          <h2 className="welcome-title">{t('ui.mascot-theme.new-session', tab.title)}</h2>
          <p className="welcome-subtitle">
            {t('ui.mascot-theme.messages-go-to-the-coding-agent-on-this')}
          </p>
        </div>
      </div>
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

/** Nomi 主对话还没有消息：欢迎屏。还没有模型时快捷问题换成「添加模型」/「选择模型」，免得一点就报错 */
const NomiWelcome: React.FC<{
  onOpenModels: () => void;
  onDispatch: (backend: DispatchBackend) => void;
}> = ({ onOpenModels, onDispatch }) => {
  const { actions } = useAiChatActions();
  const modelStatus = useNomiModelStatus();
  // 示例问题按新手引导里选的职业与兴趣推荐
  const quickPrompts = recommend(useUserProfile()).prompts;
  return (
    <div className="welcome-screen" data-testid="welcome-screen">
      <div className="welcome-content">
        <h2 className="welcome-title">{t('ui.foundation.what-would-you-like-to-do-today')}</h2>
        <DispatchCli onDispatch={onDispatch} />
        {modelStatus === 'none' || modelStatus === 'unassigned' ? (
          <div
            className="welcome-setup"
            data-testid="welcome-needs-model"
            data-status={modelStatus}
          >
            <p className="welcome-subtitle">
              {modelStatus === 'none'
                ? t('ui.foundation.nomi-has-no-model-yet-add-one-to-start')
                : t('ui.foundation.pick-one-of-your-models-for-nomi-chat')}
            </p>
            <Button variant="primary" onClick={onOpenModels} data-testid="welcome-add-model">
              {modelStatus === 'none'
                ? t('ui.foundation.getting-started-add-a-model')
                : t('ui.models.choose-a-model')}
            </Button>
          </div>
        ) : (
          <div className="quick-actions">
            {quickPrompts.map((id) => (
              <button
                key={id}
                className="quick-action-btn"
                data-testid={`quick-action-${id}`}
                onClick={() => actions.sendMessage(t(QUICK_PROMPT_TEXT[id].prompt))}
              >
                {t(QUICK_PROMPT_TEXT[id].label)}
              </button>
            ))}
          </div>
        )}
        <p className="welcome-subtitle">
          {t('ui.foundation.type-for-commands-for-knowledge-base-voice-models')}
        </p>
      </div>
    </div>
  );
};

export const ChatBody: React.FC<{
  tabs: HarnessTabsCore;
  isDev: boolean;
  /** 当前会话的键（tab:… / nomi:…）；用于按会话保存 Transcript view */
  sessionKey: string | null;
  cliMessages: ConvMessage[];
  nomiMessages: ConvMessage[];
  slash: SlashHook;
  onOpenModels: () => void;
}> = ({ tabs, isDev, sessionKey, cliMessages, nomiMessages, slash, onOpenModels }) => {
  const { view: transcriptView } = useTranscriptView(sessionKey);
  const { setMode } = useChatMode();
  const dispatch = useCallback(
    (backend: DispatchBackend) => {
      if (!isDev) setMode('dev');
      if (!tabs.available) return;
      void tabs.create(backend).catch(() => undefined);
    },
    [isDev, setMode, tabs],
  );
  const { actions, store: chatStore } = useAiChatActions();
  const busyHere = useAiChatSelector(selectBusyHere);
  const firstMessageId = useAiChatSelector(selectFirstMessageId);
  const messageCount = useAiChatSelector(selectMessageCount);
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
        messages={cliMessages}
        slash={slash}
        transcriptView={transcriptView}
      />
    );
  if (messageCount === 0 && slash.cards.length === 0)
    return <NomiWelcome onOpenModels={onOpenModels} onDispatch={dispatch} />;
  return (
    <NomiConversation
      scopeId={`nomi:${firstMessageId ?? 'new'}`}
      messages={nomiMessages}
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
