/**
 * 非焦点会话面板的视图与只读对话区（从 App.tsx 拆出）。
 *
 * - `PaneSessionView`：按面板自己绑定的 `sessionKey` 订阅 Nomi / CLI 消息与运行态（不看 currentId / activeTabId），
 *   并在 Nomi 流式回复时计算 `nomiLive`，避免非焦点面板隐藏流式正文；
 * - `PaneChatColumnBody`：渲染只读文稿与隔离的草稿输入栏（点击任意处即切焦点）。
 */
import { t, useLocale } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { CliBody, NomiWelcome, useNomiModelSwitchTip } from '../../app/ChatBody';
import { usePaneDraftKey } from '../../app/usePaneComposerDrafts';
import { railRootsOf } from '../../app/useRail';
import { resolveTabId, tabOfSessionKey } from '../../app/useSessionPanes';
import type { AiChatState } from '../../contexts/AiChatContext';
import {
  selectBusyConvos,
  selectBusyHere,
  selectIpcClient,
  useAiChatSelector,
} from '../../contexts/aiChatStore';
import {
  recoverSteerMessages,
  withDeliveredSteers,
  withInterruptedReply,
} from '../../contexts/chatTurn';
import {
  type HarnessTabsCore,
  useHarnessTabMessages,
  useHarnessTabs,
  useHarnessTabsCore,
} from '../../contexts/HarnessTabsContext';
import { ManagedRuntimeProvider } from '../../contexts/ManagedRuntimeContext';
import {
  ResourceScopeProvider,
  useResourceContext,
  type ResourceContextValue,
  type ResourceScope,
} from '../../contexts/ResourceContext';
import { useSessionPanes } from '../../contexts/SessionPanesContext';
import { useChatMode } from '../../hooks/useChatMode';
import { useSessionComposerDrafts } from '../../hooks/useSessionComposerDrafts';
import { useTranscriptView } from '../../hooks/useTranscriptView';
import { CONVERSATIONS_CHANGED_EVENT } from '../../services/conversationStore';
import type { HarnessTabMeta } from '../../services/harnessClient';
import { useProject } from '../../services/projects';
import { reportedModel } from '../../slash/tokens';
import type { SlashCard } from '../../slash/types';
import type { SlashHook } from '../../slash/useSlashCommands';
import type { ConvLive, ConvMessage } from '../../types/conversation';
import {
  fromHarnessMessage,
  nomiConvMessages,
  nomiLive,
  settledNomiMessages,
} from '../../utils/convAdapters';
import { parseSessionKey } from '../../utils/sessionPanes';
import { ConversationView } from '../Conversation';
import { nomiSlots } from '../Conversation/nomiSlots';
import { nomiTraceSlots } from '../Conversation/TraceAction';
import { MessageInput } from '../MessageInput';

import paneStyles from './index.module.css';

export interface PaneSessionViewValue {
  sessionKey: string;
  nomiId: string | undefined;
  cliTabId: string | undefined;
  backend: string;
  nomiMessages: ConvMessage[];
  nomiLive: ConvLive | undefined;
  cliMessages: ConvMessage[];
  hasMessages: boolean;
  /** Nomi 会话有没有消息（不读消息体：草稿键用） */
  hasNomiMessages: boolean;
  running: boolean;
  projectId: string | undefined;
  cwd: string | null;
}

export const PaneSessionView: React.FC<{
  sessionKey: string | null;
  children: (view: PaneSessionViewValue) => React.ReactNode;
}> = React.memo(function PaneSessionView({ sessionKey, children }) {
  const parsed = useMemo(() => parseSessionKey(sessionKey), [sessionKey]);
  const locale = useLocale();
  const ipcClient = useAiChatSelector(selectIpcClient);
  const tabs = useHarnessTabs();
  const store = ipcClient?.conversationStore?.();
  const nomiId = parsed?.kind === 'nomi' ? parsed.id : undefined;
  // 先在标签列表里把 cli:<backend>:<sessionId> 反查回真实的 harness tab.id，再订阅该标签的消息缓存
  const tab = useMemo(
    () => tabOfSessionKey(tabs.state?.tabs, sessionKey),
    [tabs.state?.tabs, sessionKey],
  );
  const cliTabId =
    parsed && parsed.kind !== 'nomi'
      ? (tab?.id ?? resolveTabId(tabs.state?.tabs, sessionKey))
      : undefined;
  const tabId = cliTabId ?? null;
  const tabMessages = useHarnessTabMessages(tabId);
  const busyConvos = useAiChatSelector(selectBusyConvos);
  const running = !!nomiId && !!busyConvos?.includes(nomiId);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!nomiId) return;
    const sync = () => bump((n) => n + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, sync);
  }, [nomiId]);
  const loaded = !!nomiId && !!store?.isLoaded(nomiId);
  useEffect(() => {
    if (!nomiId || !store || loaded) return;
    let alive = true;
    void store.loadMessages(nomiId).then(
      () => alive && bump((n) => n + 1),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [nomiId, store, loaded]);
  // 仅关注自身绑定会话的版本，避免另一侧面板流式输出或切焦点导致非焦点面板重绘
  const selectOwnVersion = useCallback(
    (s: AiChatState) =>
      nomiId && s.viewConvoId === nomiId
        ? `${s.messages.length}:${s.messages[s.messages.length - 1]?.id ?? ''}:${selectBusyHere(s) ? 1 : 0}`
        : '',
    [nomiId],
  );
  const messagesVersion = useAiChatSelector(selectOwnVersion);
  const view = useMemo<PaneSessionViewValue | null>(() => {
    if (!parsed) return null;
    if (parsed.kind === 'nomi') {
      const meta = store?.get(parsed.id);
      const rawMessages = loaded ? (store?.getMessages(parsed.id) ?? []) : [];
      const hasStored = rawMessages.length > 0 || (store?.hasMessages(parsed.id) ?? false);
      const applied = running
        ? rawMessages
        : withDeliveredSteers(rawMessages, meta?.deliveredSteers).history;
      const recovered = recoverSteerMessages(applied, running);
      const displayMessages = running ? recovered : withInterruptedReply(recovered);
      return {
        sessionKey: `nomi:${parsed.id}`,
        nomiId: parsed.id,
        cliTabId: undefined,
        backend: 'nomi',
        nomiMessages: nomiConvMessages(settledNomiMessages(displayMessages, running)),
        nomiLive: running ? nomiLive(rawMessages, true) : undefined,
        cliMessages: [],
        hasMessages: hasStored || running,
        hasNomiMessages: hasStored,
        running,
        projectId: meta?.projectId,
        cwd: null,
      };
    }
    const backend = tab?.backend ?? (parsed.kind === 'cli' ? parsed.backend : 'claude');
    return {
      sessionKey: sessionKey!,
      nomiId: undefined,
      cliTabId: tab?.id ?? cliTabId,
      backend,
      nomiMessages: [],
      nomiLive: undefined,
      cliMessages: tabMessages.map((m) => fromHarnessMessage(m, backend)),
      hasMessages: tabMessages.length > 0,
      hasNomiMessages: false,
      running: tab?.status === 'running' || tab?.status === 'queued',
      projectId: tab?.projectId,
      cwd: tab?.cwd ?? null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- messagesVersion/locale：消息或语言变了才重算
  }, [
    parsed,
    store,
    loaded,
    running,
    messagesVersion,
    locale,
    tab,
    tabMessages,
    sessionKey,
    cliTabId,
  ]);
  if (!view) return null;
  return <>{children(view)}</>;
});

/**
 * 面板会话渲染用的 harness 标签视图：非焦点面板的 CLI 会话不一定在当前标签上，
 * 而 ChatBody 的「空标签欢迎语 / 开关」按 tabs.isCliTab 判断，这里把当前标签换成面板自己的。
 */
function paneTabs(terminal: HarnessTabsCore, tab: HarnessTabMeta | undefined): HarnessTabsCore {
  if (!tab) return { ...terminal, isCliTab: false, messages: [] };
  return {
    ...terminal,
    activeTabId: tab.id,
    activeTab: tab,
    isCliTab: true,
    messages: terminal.isCliTab && terminal.activeTab?.id === tab.id ? terminal.messages : [],
  };
}

/** 非焦点面板是只读文稿：不给斜杠卡片（卡片按「当前会话」记，点过来成了焦点面板再给） */
const PANE_READONLY_SLASH = {
  cards: [] as readonly SlashCard[],
  dismissCard: () => undefined,
} as unknown as SlashHook;

/** 非焦点面板保留「重试」按钮外形与交互，真实点击会先由 SessionPane 切为焦点 */
const NOOP_RETRY = () => undefined;

/** 必须在 `<ManagedRuntimeProvider>` 内读取该面板自己的底座与模型切换提示，避免切焦点后提示条消失 */
const PaneNomiConversation: React.FC<{
  view: PaneSessionViewValue;
  transcriptView: ReturnType<typeof useTranscriptView>['view'];
}> = ({ view, transcriptView }) => {
  const { isDev } = useChatMode();
  const modelSwitchTip = useNomiModelSwitchTip(view.nomiMessages);
  return (
    <ConversationView
      scopeId={view.sessionKey}
      messages={view.nomiMessages}
      live={view.nomiLive}
      transcriptView={transcriptView}
      phase={view.running ? 'running' : 'idle'}
      modelSwitchTip={modelSwitchTip}
      onRetry={NOOP_RETRY}
      slots={isDev ? nomiTraceSlots : nomiSlots}
    />
  );
};

/**
 * 非焦点面板的对话区（并排会话里不接收键盘的那一列）。
 */
export const PaneChatColumnBody: React.FC<{
  view: PaneSessionViewValue;
  paneId: string;
}> = React.memo(function PaneChatColumnBody({ view, paneId }) {
  const core = useHarnessTabsCore();
  const harness = useHarnessTabs();
  const drafts = useSessionComposerDrafts();
  const tabList = harness.state?.tabs;
  const tab = useMemo(() => tabOfSessionKey(tabList, view.sessionKey), [tabList, view.sessionKey]);
  const draftKey = usePaneDraftKey({ sessionKey: view.sessionKey, tabId: view.cliTabId });
  const { view: transcriptView } = useTranscriptView(view.sessionKey);
  const tabs = useMemo(() => paneTabs(core, tab), [core, tab]);
  const project = useProject(view.projectId);
  const paneCwd = view.cliTabId
    ? (view.cwd ?? project?.primary ?? null)
    : (project?.primary ?? null);
  const paneRoots = useMemo(() => railRootsOf(paneCwd, project), [paneCwd, project]);
  const fallbackCwds = useMemo(() => {
    const rest = (paneRoots ?? []).filter((r) => r && r !== paneCwd);
    return rest.length > 0 ? rest : undefined;
  }, [paneRoots, paneCwd]);
  const parentResource = useResourceContext();
  const panes = useSessionPanes();
  const paneResource = useMemo<ResourceContextValue | null>(() => {
    if (!parentResource) return null;
    const scope: ResourceScope = {
      id: view.sessionKey,
      cwd: paneCwd,
      source: view.cliTabId ? view.backend : 'nomi',
      ...(fallbackCwds ? { fallbackCwds } : {}),
    };
    return {
      ...parentResource,
      scope,
      open: (href, targetScope, image) => {
        if (panes && panes.focusedPaneId !== paneId) panes.focusPane(paneId);
        parentResource.open(href, { ...scope, ...targetScope }, image);
      },
      ...(parentResource.openDiff
        ? {
            openDiff: (diff) => {
              if (panes && panes.focusedPaneId !== paneId) panes.focusPane(paneId);
              parentResource.openDiff?.({ ...diff, cwd: diff.cwd ?? paneCwd });
            },
          }
        : {}),
    };
  }, [
    parentResource,
    view.sessionKey,
    view.cliTabId,
    view.backend,
    paneCwd,
    fallbackCwds,
    panes,
    paneId,
  ]);
  const empty = !view.hasMessages;
  const placeholder = view.running
    ? t('ui.session-panes.running')
    : !view.cliTabId && empty
      ? t('ui.foundation.type-for-commands-for-knowledge-base-voice-models')
      : undefined;
  const columnBody = (
    <ManagedRuntimeProvider conversationId={view.nomiId} hidden={!!view.cliTabId}>
      <div
        className="session-pane-column"
        data-testid="session-pane-body"
        data-pane={paneId}
        data-empty={empty ? 'true' : undefined}
      >
        <main className="chat-container session-pane-chat">
          {view.cliTabId ? (
            tab ? (
              <CliBody
                tabs={tabs}
                // 终端入口只在开发模式下有：非焦点面板按面板自己的标签读，与当前标签是谁无关
                isDev
                messages={view.cliMessages}
                slash={PANE_READONLY_SLASH}
                transcriptView={transcriptView}
              />
            ) : (
              <NomiWelcome />
            )
          ) : empty ? (
            <NomiWelcome />
          ) : (
            <PaneNomiConversation view={view} transcriptView={transcriptView} />
          )}
        </main>
        {/* 只读的输入栏：显示这一列自己的草稿与模型/运行时（与焦点面板隔离），不能键盘输入；点它切成焦点后继续用焦点面板的输入框 */}
        <footer className="input-container session-pane-footer" inert>
          <MessageInput
            disabled
            cwd={paneCwd ?? undefined}
            roots={paneRoots ?? undefined}
            endpointTab={view.cliTabId ? (tab ?? null) : null}
            contextMessages={view.cliTabId ? view.cliMessages : view.nomiMessages}
            contextModel={
              view.cliTabId
                ? (tab?.modelOverride ?? reportedModel(view.cliMessages) ?? tab?.backend)
                : undefined
            }
            draftStore={drafts.draftStore}
            draftKey={draftKey}
            placeholder={placeholder}
          />
        </footer>
      </div>
    </ManagedRuntimeProvider>
  );
  return paneResource ? (
    <ResourceScopeProvider value={paneResource}>{columnBody}</ResourceScopeProvider>
  ) : (
    columnBody
  );
});

/** 拆分出的空面板占位：避免空面板一片空白或重复显示原会话 */
export const EmptySessionPane: React.FC<{
  paneId: string;
  onNewChat?: () => void;
}> = ({ paneId, onNewChat }) => {
  useLocale();
  return (
    <div className={paneStyles.emptyPane} data-testid="session-pane-empty" data-pane={paneId}>
      <p className={paneStyles.emptyHint}>{t('ui.session-panes.hint')}</p>
      {onNewChat && (
        <button
          type="button"
          className={paneStyles.emptyAction}
          data-testid="session-pane-empty-new"
          onClick={onNewChat}
        >
          {t('ui.cli-monitor.new-conversation')}
        </button>
      )}
    </div>
  );
};
