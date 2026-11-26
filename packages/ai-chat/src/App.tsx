import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import * as AISdkReact from '@nomi-ai/ai-sdk-client/react';
import { t, usePresence } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { AppOverlays, useToast } from './app/AppOverlays';
import { ChatBody, CliBody, NomiWelcome } from './app/ChatBody';
import { useAppCommands } from './app/useAppCommands';
import { useAppPanels } from './app/useAppPanels';
import { useAppSlash } from './app/useAppSlash';
import { useCliContext } from './app/useCliContext';
import { usePaneDraftKey } from './app/usePaneComposerDrafts';
import { useRail } from './app/useRail';
import { useSelectionActions } from './app/useSelectionActions';
import {
  paneTabInfo,
  syncCurrentToPane,
  tabIdOfSessionKey,
  useSessionPaneLayout,
} from './app/useSessionPanes';
import { useSplitWidths } from './app/useSplitWidths';
import { StartupReady } from './components/BrandIntro/StartupReady';
import { ChatBackgroundLayer } from './components/ChatBackground/ChatBackgroundLayer';
import { ChatHeader } from './components/ChatHeader';
import { ComputerActivityBar } from './components/ComputerActivityBar';
import { ConversationView } from './components/Conversation';
import { ForkFromMessageContext } from './components/Conversation/forkContext';
import { nomiSlots } from './components/Conversation/nomiSlots';
import { nomiTraceSlots } from './components/Conversation/TraceAction';
import { CliWelcomeActions } from './components/ConversationWelcome/CliWelcomeActions';
import { WelcomeActions } from './components/ConversationWelcome/WelcomeActions';
import { DesktopConfirmDock } from './components/DesktopConfirmDock';
import { NewChatContext, SessionControls } from './components/EndpointControls';
import { ErrorBoundary } from './components/ErrorBoundary';
import { prefetchPanels, SettingsView } from './components/lazyPanels';
import { ManagedRuntimeDock } from './components/ManagedRuntimeDock';
import { MessageInput } from './components/MessageInput';
import { SendBlockedHint } from './components/MessageInput/SendBlockedHint';
import { onboardingClient } from './components/Onboarding/client';
import { OnboardingHost } from './components/Onboarding/host';
import { PendingDock } from './components/PendingDock';
import { PREVIEW_CHAT_OPEN } from './components/PreviewChat/dismiss';
import { ProviderLinkHost } from './components/ProviderLink';
import { ReleaseNotesHost } from './components/ReleaseNotesModal';
import { RestartUpdateButton } from './components/RestartUpdateButton';
import { SelectionToolbar } from './components/SelectionToolbar';
import { SessionDetailsDock, useSessionDetails } from './components/SessionDetails';
import { SessionPane, type PaneTabInfo } from './components/SessionPane';
import { ChatColumn } from './components/SessionPane/ChatColumn';
import { useChangesUi } from './components/SessionWorkspace';
import { Sidebar } from './components/Sidebar';
import {
  SideSplitHandle,
  SideTabStrip,
  SideWorkspace,
  useSideWorkspace,
  useSideWorkspaceKeys,
} from './components/SideWorkspace';
import {
  useSubagentPane,
  WorkspacePanesProvider,
  type SubagentPaneActions,
} from './components/SubagentPane';
import { AppTitleBar, hasAppTitleBar } from './components/TitleBar';
import { TitlebarPanelsProvider } from './components/TitleBar/panels';
import { SessionTitle, SessionTools, TitleBarTitle } from './components/TitleBar/SessionTitle';
import { UserQuestionDock } from './components/UserQuestionCard/dock';
import { AiChatContextProvider } from './contexts/AiChatContext';
import type { AiChatState } from './contexts/AiChatContext';
import {
  selectFirstMessageId,
  selectBusyConvos,
  selectBusyHere,
  selectIpcClient,
  selectIsLoading,
  selectViewConvoId,
  shallowArrayEqual,
  useAiChatActions,
  useAiChatSelector,
} from './contexts/aiChatStore';
import {
  HarnessTabsProvider,
  type HarnessTabsCore,
  useHarnessTabs,
  useHarnessTabMessages,
  useHarnessTabsCore,
} from './contexts/HarnessTabsContext';
import { ManagedRuntimeProvider } from './contexts/ManagedRuntimeContext';
import { ResourceScopeProvider } from './contexts/ResourceContext';
import { SelectionActionsContext } from './contexts/SelectionActionsContext';
import { SessionPanesProvider, useSessionPanes } from './contexts/SessionPanesContext';
import { useChatMode } from './hooks/useChatMode';
import { useCliTabReadiness } from './hooks/useCliTabReadiness';
import { useComposerPending } from './hooks/useComposerPending';
import { useHarnessState } from './hooks/useHarnessState';
import { useIslandOpenItem } from './hooks/useIslandOpenItem';
import { useMainPages } from './hooks/useMainPages';
import { useResourcePreview } from './hooks/useResourcePreview';
import { useRestoreNomiOnMain } from './hooks/useRestoreNomiOnMain';
import { useSessionComposerDrafts } from './hooks/useSessionComposerDrafts';
import { useWorkspaceLayoutMotion } from './hooks/useTabMotion';
import { useTranscriptView } from './hooks/useTranscriptView';
import { useMigrateCliTranscriptView } from './hooks/useTranscriptView';
import { useWindowEvent } from './hooks/useWindowEvent';
import { toHarnessImages } from './services/chatImages';
import { watchCliPresence } from './services/cliPresence';
import { smartTitleOnFirstSend } from './services/cliSmartTitle';
import {
  CONVERSATIONS_CHANGED_EVENT,
  notifyConversationsChanged,
  type ConversationStore,
} from './services/conversationStore';
import { MAIN_TAB_ID, type HarnessTabMeta } from './services/harnessClient';
import { openModelMenu } from './services/modelMenu';
import { watchNomiModel } from './services/nomiModel';
import type { ImageAttachment } from './services/screenClient';
import { cliTranscriptKey } from './services/transcriptView';
import { reportedModel } from './slash/tokens';
import type { SlashCard } from './slash/types';
import type { SlashHook } from './slash/useSlashCommands';
import type { ConvMessage } from './types/conversation';
import { CHAT_COL_RATIO_MAX, CHAT_COL_RATIO_MIN } from './utils/chatColumnWidth';
import { useCliImageSupport } from './utils/cliImageSupport';
import { cliTabPlaceholder } from './utils/cliTabPlaceholder';
import { fromHarnessMessage, nomiConvMessages, settledNomiMessages } from './utils/convAdapters';
import { CHAT_DROP_FILE_PATH_EVENT } from './utils/filePathDrag';
import {
  cliSessionKey,
  nomiSessionKey,
  PANE_RATIO_MAX,
  PANE_RATIO_MIN,
  paneKeysKey,
  parseSessionKey,
} from './utils/sessionPanes';
import { CHANGES_SIDE_TAB, MAIN_SIDE_TAB, OPEN_FILE_SIDE_TAB } from './utils/sideTabs';
import './App.css';
import './components/TitleBar/panels.css';

const selectSettledNomi = (s: AiChatState) => settledNomiMessages(s.messages, selectBusyHere(s));
/** 当前会话的消息版本（条数 + 最后一条的 id + 流式状态）：非焦点面板按它重读自己那一份 */
const selectMessagesVersion = (s: AiChatState) =>
  `${s.messages.length}:${s.messages[s.messages.length - 1]?.id ?? ''}:${selectBusyHere(s) ? 1 : 0}`;

/**
 * 实时计算当前主列会话的唯一标识：
 * - CLI 标签激活时使用 cliTranscriptKey（新标签为 tab:<id>，拿到会话 id 后升级为 cli:<backend>:<id>）；
 * - Nomi 会话监听 CONVERSATIONS_CHANGED_EVENT 与 viewConvoId，切换或新建会话的第 0ms 立即同步，
 *   且过滤掉 CLI 镜像项 id，绝不把镜像项误认成 Nomi 会话。
 */
function useActiveSessionInfo(opts?: { focusedTab?: HarnessTabMeta | null }) {
  const ipcClient = useAiChatSelector(selectIpcClient);
  const viewConvoId = useAiChatSelector(selectViewConvoId);
  const tabs = useHarnessTabsCore();
  const { isDev } = useChatMode();
  const [storeVersion, setStoreVersion] = useState(0);
  useEffect(() => {
    const onChanged = () => setStoreVersion((v) => v + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, onChanged);
  }, []);
  const nomiSessionId = useMemo(() => {
    void storeVersion;
    const store = ipcClient?.conversationStore?.();
    if (store) {
      const cur = store.currentId();
      if (cur && store.isNomi(cur)) return cur;
      if (viewConvoId && store.isNomi(viewConvoId)) return viewConvoId;
      return store.lastNomiId() ?? viewConvoId;
    }
    return viewConvoId ?? ipcClient?.currentConversationId?.();
  }, [ipcClient, viewConvoId, storeVersion]);
  // 并排会话时以焦点面板的标签为准（它可能还不是 harness 的当前标签）；不给时与原来一致
  const focusedTab = opts?.focusedTab;
  const activeCliTab = focusedTab ? focusedTab : isDev && tabs.isCliTab ? tabs.activeTab : null;
  const sessionKey = activeCliTab
    ? cliTranscriptKey(activeCliTab)
    : nomiSessionId
      ? `nomi:${nomiSessionId}`
      : null;
  return { sessionKey, nomiSessionId, activeCliTab };
}

/**
 * 并排会话里的一列要显示的内容（按这一列**绑定的会话键**读，不看 currentId / activeTabId）。
 *
 * - Nomi 会话：conversationStore 已加载就同步读 getMessages（跟着会话列表变化重读，流式的这一轮
 *   由 AiChatContext 按会话写进缓存），没加载过就先 loadMessages，加载完补回来；
 * - CLI 标签：useHarnessTabMessages(tabId)，不必是当前标签，标签在后台跑也照样更新。
 * 斜杠卡片不进这一列（它按「当前会话」记）：非焦点面板只读展示，点一下它才切成焦点再用输入框。
 */
export interface PaneSessionViewValue {
  sessionKey: string;
  nomiId: string | undefined;
  cliTabId: string | undefined;
  backend: string;
  nomiMessages: ConvMessage[];
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
}> = ({ sessionKey, children }) => {
  const parsed = useMemo(() => parseSessionKey(sessionKey), [sessionKey]);
  const ipcClient = useAiChatSelector(selectIpcClient);
  const tabs = useHarnessTabs();
  const store = ipcClient?.conversationStore?.();
  const nomiId = parsed?.kind === 'nomi' ? parsed.id : undefined;
  // harness 标签 id：tab:<id> 就是它；cli:<backend>:<会话 id> 没有标签 id（只有会话 id），
  // 与 tabIdOfSessionKey 的口径一致，再在标签列表里按 cliSessionId 反查回标签
  const cliTabId = parsed && parsed.kind !== 'nomi' ? tabIdOfSessionKey(sessionKey) : undefined;
  const tabId = cliTabId ?? null;
  const tabMessages = useHarnessTabMessages(tabId);
  const busyConvos = useAiChatSelector(selectBusyConvos);
  const running = !!nomiId && !!busyConvos?.includes(nomiId);
  // 会话列表 / 消息有变化时重读（流式那一轮由 AiChatContext 写进会话缓存，树会重渲染）
  const [, bump] = useState(0);
  useEffect(() => {
    if (!nomiId) return;
    // 会话列表变化（改名、删除、别的窗口写入）就重读
    const sync = () => bump((n) => n + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, sync);
  }, [nomiId]);
  // 没加载过的会话先加载（加载完 bump 一次）；已加载的直接同步读
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
  // 每一帧 / 每一轮提交都重读：会话里的消息变了，这一列要跟着更新（流式中只有这一列重渲染，不牵动整棵树）
  const messagesVersion = useAiChatSelector(selectMessagesVersion);
  const view = useMemo<PaneSessionViewValue | null>(() => {
    if (!parsed) return null;
    if (parsed.kind === 'nomi') {
      const meta = store?.get(parsed.id);
      const messages = loaded ? (store?.getMessages(parsed.id) ?? []) : [];
      return {
        sessionKey: `nomi:${parsed.id}`,
        nomiId: parsed.id,
        cliTabId: undefined,
        backend: 'nomi',
        nomiMessages: nomiConvMessages(settledNomiMessages(messages, running)),
        cliMessages: [],
        hasMessages: messages.length > 0 || (store?.hasMessages(parsed.id) ?? false),
        hasNomiMessages: messages.length > 0 || (store?.hasMessages(parsed.id) ?? false),
        running,
        projectId: meta?.projectId,
        cwd: null,
      };
    }
    const tab =
      tabs.state?.tabs.find((t) => t.id === cliTabId) ??
      (parsed.kind === 'cli'
        ? tabs.state?.tabs.find(
            (t) => t.backend === parsed.backend && t.cliSessionId === parsed.sessionId,
          )
        : undefined);
    const backend = tab?.backend ?? (parsed.kind === 'cli' ? parsed.backend : 'claude');
    return {
      sessionKey: sessionKey!,
      nomiId: undefined,
      cliTabId: tab?.id ?? cliTabId,
      backend,
      nomiMessages: [],
      cliMessages: tabMessages.map((m) => fromHarnessMessage(m, backend)),
      hasMessages: tabMessages.length > 0,
      hasNomiMessages: false,
      running: tab?.status === 'running' || tab?.status === 'queued',
      projectId: tab?.projectId,
      cwd: tab?.cwd ?? null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- messagesVersion：消息变了才重读（见上）
  }, [
    parsed,
    store,
    loaded,
    running,
    messagesVersion,
    tabs.state?.tabs,
    tabMessages,
    sessionKey,
    cliTabId,
  ]);
  if (!view) return null;
  return <>{children(view)}</>;
};

/** 会话键 → CLI 标签（面板标题用）：tab:<id> 直接查，cli:<backend>:<会话 id> 按会话 id 反查 */
export function usePaneTabLookup(): (sessionKey: string | null) => PaneTabInfo | undefined {
  const tabs = useHarnessTabs();
  const list = tabs.state?.tabs;
  return useCallback(
    (key: string | null) => {
      if (!key || !list) return undefined;
      return paneTabInfo(tabOfSessionKey(list, key));
    },
    [list],
  );
}

/**
 * 「当前会话」的快照（Provider 的 onFocusSession / seed 用）：不订阅、只在被调用时读最新值。
 * 读的是 store 的指针与 harness 标签上下文，不触发重渲染。
 */
export function useCurrentSessionSnapshot(): () => string | null {
  const ipcClient = useAiChatSelector(selectIpcClient);
  const viewConvoId = useAiChatSelector(selectViewConvoId);
  const tabs = useHarnessTabs();
  return useCallback(() => {
    const t = tabs;
    const meta = t.state?.tabs.find((x) => x.id === t.activeTabId);
    if (meta && meta.id !== MAIN_TAB_ID) return cliSessionKey(meta);
    const store = ipcClient?.conversationStore?.();
    if (store) {
      const cur = store.currentId();
      if (cur && store.isNomi(cur)) return nomiSessionKey(cur);
      return nomiSessionKey(store.lastNomiId() ?? viewConvoId);
    }
    return nomiSessionKey(viewConvoId ?? ipcClient?.currentConversationId?.());
  }, [ipcClient, viewConvoId, tabs]);
}

/** 会话键 → harness 标签（Nomi 会话为 undefined）：tab 用标签 id，cli 用会话 id 反查，与 tabIdOfSessionKey 一致 */
export function tabOfSessionKey(
  tabs: readonly HarnessTabMeta[] | undefined,
  key: string | null,
): HarnessTabMeta | undefined {
  const parsed = parseSessionKey(key);
  if (!parsed || parsed.kind === 'nomi' || !tabs) return undefined;
  if (parsed.kind === 'tab') return tabs.find((t) => t.id === parsed.id);
  return tabs.find((t) => t.backend === parsed.backend && t.cliSessionId === parsed.sessionId);
}

/**
 * 面板会话渲染用的 harness 标签视图：非焦点面板的 CLI 会话不一定在当前标签上，
 * 而 ChatBody 的「空标签欢迎语 / 开关」按 tabs.isCliTab 判断，这里把当前标签换成面板自己的，
 * send / activate 等动作仍是 harness 的真函数（只读展示这一列，发送走焦点面板）。
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

/**
 * 非焦点面板的对话区（并排会话里不接收键盘的那一列）。
 *
 * - 消息按这一列**绑定的会话**读（PaneSessionView），与焦点面板的「当前会话」互不替换；
 * - 是只读的完整文稿：不挂斜杠卡片、授权卡、会话详情这些按「当前会话」记的整列级组件；
 *   点这一列任意处就把焦点切过来（SessionPane 的按下捕获负责），之后发送走原来按当前会话的路径；
 * - 输入框用与焦点面板隔离的草稿键（usePaneDraftKey，按这一列自己的会话算），不计入分区树（inert）：
 *   看得见、不能用键盘输入；侧栏点过来再点走，两边各留各的草稿。
 */
export const PaneChatColumnBody: React.FC<{
  view: PaneSessionViewValue;
  paneId: string;
}> = ({ view, paneId }) => {
  const core = useHarnessTabsCore();
  const harness = useHarnessTabs();
  const drafts = useSessionComposerDrafts();
  const tabList = harness.state?.tabs;
  const tab = useMemo(() => tabOfSessionKey(tabList, view.sessionKey), [tabList, view.sessionKey]);
  const draftKey = usePaneDraftKey({ sessionKey: view.sessionKey, tabId: view.cliTabId });
  const { view: transcriptView } = useTranscriptView(view.sessionKey);
  const tabs = useMemo(() => paneTabs(core, tab), [core, tab]);
  const empty = !view.hasMessages;
  return (
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
          <ConversationView
            scopeId={view.sessionKey}
            messages={view.nomiMessages}
            transcriptView={transcriptView}
            phase={view.running ? 'running' : 'idle'}
            slots={view.running ? nomiTraceSlots : nomiSlots}
          />
        )}
      </main>
      {/* 只读的输入栏：显示这一列自己的草稿（与焦点面板按会话隔离），不能键盘输入；点它切成焦点后继续用焦点面板的输入框 */}
      <footer className="input-container session-pane-footer" inert>
        <MessageInput
          disabled
          cwd={view.cwd ?? undefined}
          draftStore={drafts.draftStore}
          draftKey={draftKey}
          placeholder={view.running ? t('ui.session-panes.running') : t('ui.session-panes.hint')}
        />
      </footer>
    </div>
  );
};

/**
 * 对话窗口的组装：侧栏 | 对话卡片（对话列、中栏、会话详情、整页、右栏）+ 覆盖层。
 * 各部分的状态在 app/ 下的 hook 里；这里只订阅需要的切片：流式输出的一帧只改最后一轮，
 * 由 NomiConversation（app/ChatBody）自己订阅，App 与其余部分不跟着重渲染。
 */
const AiChatContent: React.FC = () => {
  const split = useSplitWidths();
  const { composerFill, workbench, closeWorkbench, closeDetail } = useChangesUi();
  const { actions } = useAiChatActions();
  const isLoading = useAiChatSelector(selectIsLoading);
  const busyHere = useAiChatSelector(selectBusyHere);
  const ipcClient = useAiChatSelector(selectIpcClient);
  const firstMessageId = useAiChatSelector(selectFirstMessageId);
  const settledNomi = useAiChatSelector(selectSettledNomi, shallowArrayEqual);
  // 不订阅完整标签列表：后台标签的状态 / 未读广播不让整个 App 重渲染
  const tabs = useHarnessTabsCore();
  const { isDev } = useChatMode();
  const harness = useHarnessState();
  // ───── 主区的会话面板：并排时焦点面板就是「当前会话」 ─────
  const allTabs = useHarnessTabs();
  const sessionPanes = useSessionPanes();
  const openSessionToSide = useCallback(
    (sessionKey: string | null) => sessionPanes?.openToSide(sessionKey),
    [sessionPanes],
  );
  // 侧栏单击：只换焦点面板（已打开的另一面板 / 另一个工程的会话不动）
  const openSessionInFocus = useCallback(
    (sessionKey: string | null) => sessionPanes?.openSessionInFocus(sessionKey),
    [sessionPanes],
  );
  // 面板标题要的 CLI 标签：会话键 → 标签（cli:<backend>:<会话 id> 按会话 id 反查）
  const paneTabOf = usePaneTabLookup();
  // 焦点面板绑定的 CLI 标签（并排时它可能还不是 harness 的当前标签）：标题、右栏、文件根都按它
  const focusedPaneKey = sessionPanes?.focusedKey ?? null;
  const focusedTabId = tabIdOfSessionKey(focusedPaneKey);
  const focusedTab = useMemo(
    () =>
      (focusedTabId ? allTabs.state?.tabs.find((t) => t.id === focusedTabId) : undefined) ?? null,
    [focusedTabId, allTabs.state?.tabs],
  );
  // 当前会话的键：CLI 标签与 Nomi 对话统一使用实时响应的 sessionKey，
  // Transcript view、工作区 Tabs 与文件预览全部按这个键分开保存，切换会话互不影响。
  // 并排时以焦点面板的标签为准（见 useActiveSessionInfo）。
  const { sessionKey, nomiSessionId, activeCliTab } = useActiveSessionInfo({ focusedTab });
  // agent 标签拿到会话 id 后，把按标签存的 Transcript view 覆盖搬到会话键（关标签、从历史重开也在）
  useMigrateCliTranscriptView(activeCliTab);
  // ───── 统一会话视图的数据：Nomi 主对话与 agent 标签走同一个 ConversationView ─────
  const nomiMessages = useMemo(() => nomiConvMessages(settledNomi), [settledNomi]);
  // 焦点面板的 CLI 标签：并排时可能是别的标签（不是 harness 当前标签），消息按它的 id 读
  const focusedPaneIsCli = !!focusedTab;
  const paneTabMessages = useHarnessTabMessages(focusedPaneIsCli ? focusedTab!.id : null);
  const cliBackend = (focusedTab ?? tabs.activeTab)?.backend ?? 'claude';
  const cliConvMessages = useMemo(() => {
    const raw = focusedTab ? paneTabMessages : tabs.isCliTab ? tabs.messages : [];
    return raw.map((m) => fromHarnessMessage(m, focusedTab?.backend ?? cliBackend));
  }, [focusedTab, paneTabMessages, tabs.isCliTab, tabs.messages, cliBackend]);
  const { liveContext, cliContextMessages } = useCliContext(tabs, cliConvMessages);
  const rail = useRail({
    tabs,
    isDev,
    harness,
    busyHere,
    cliConvMessages,
    nomiMessages,
    ...(focusedTab ? { focusedTab } : {}),
  });
  // 对话旁的标签区（子任务 + 文件）：外层 ScopedWorkspacePanes 已按 sessionKey 同帧同步注入 scope
  const pane = useSubagentPane();
  // 侧边聊天带上当前会话所属的项目（只读）
  const setPaneProject = pane?.setProjectId;
  useEffect(() => {
    setPaneProject?.(rail.projectId ?? null);
  }, [setPaneProject, rail.projectId]);
  const openChangesTab = pane?.openChanges;
  const prevSessionKeyRef = useRef(sessionKey);
  const prevWorkbenchRef = useRef(workbench);
  useEffect(() => {
    const sessionChanged = prevSessionKeyRef.current !== sessionKey;
    prevSessionKeyRef.current = sessionKey;
    const workbenchChanged = prevWorkbenchRef.current !== workbench;
    prevWorkbenchRef.current = workbench;
    if (sessionChanged) {
      closeWorkbench();
      closeDetail();
      return;
    }
    if (workbenchChanged && workbench) {
      openChangesTab?.();
    }
  }, [sessionKey, workbench, openChangesTab, closeWorkbench, closeDetail]);
  const activatePane = pane?.activate;
  const fallbackCwds = useMemo(() => {
    const rest = (rail.roots ?? []).filter((r) => r && r !== rail.cwd);
    return rest.length > 0 ? rest : undefined;
  }, [rail.roots, rail.cwd]);
  const resourcePreview = useResourcePreview(
    {
      id: sessionKey ?? '',
      cwd: rail.cwd,
      source: isDev && tabs.isCliTab ? tabs.activeTab?.backend : 'nomi',
      fallbackCwds,
    },
    // 开了 / 切到一个文件：标签区切到文件；按会话分桶存储预览列表
    {
      scoped: true,
      onShow: (kind) => {
        if (kind === 'diff') {
          pane?.openChanges?.();
          activatePane?.(CHANGES_SIDE_TAB);
        } else {
          pane?.openFileBrowser?.();
          activatePane?.(OPEN_FILE_SIDE_TAB);
        }
      },
    },
  );
  // agent 新标签拿到 cliSessionId 后，绘制前把已打开的工作区 Tabs 与文件预览平滑迁移到稳定会话键
  const migratePaneScope = pane?.migrateScope;
  const migratePreviewScope = resourcePreview.migrateScope;
  const cliTabId = activeCliTab?.id;
  useLayoutEffect(() => {
    if (!cliTabId || !sessionKey || sessionKey === `tab:${cliTabId}`) return;
    const fromKey = `tab:${cliTabId}`;
    migratePaneScope?.(fromKey, sessionKey);
    migratePreviewScope(fromKey, sessionKey);
  }, [cliTabId, sessionKey, migratePaneScope, migratePreviewScope]);
  const side = useSideWorkspace({
    entries: resourcePreview.entries,
    activeKey: resourcePreview.activeKey,
    render: resourcePreview.renderEmbedded,
    closeEntries: resourcePreview.closeEntries,
    railSplit: split.filesRail,
  });
  useSideWorkspaceKeys(side);
  const selectionActions = useSelectionActions(side);
  // 选区菜单「问助手」往输入框里填引用：铺满时先切到主会话标签
  useWindowEvent(PREVIEW_CHAT_OPEN, () => {
    if (side.maximized) activatePane?.(MAIN_SIDE_TAB);
  });
  const details = useSessionDetails();
  const panels = useAppPanels();
  const closeSettings = panels.closeSettings;
  // 子任务侧栏里的设置 / 插件 / 模型等按钮：打开主窗口的同一组面板
  const { openPlugins, openProviders, onInputSettings, openDesktop, openHub, openExt, openLocal } =
    panels;
  const paneActions = useMemo<SubagentPaneActions>(
    () => ({
      openPlugins,
      openProviders,
      openSettings: onInputSettings,
      openCodingSettings: (backend) => onInputSettings('ai', backend, 'assistants'),
      openDesktop,
      openHub,
      openExt,
      openLocal,
    }),
    [openPlugins, openProviders, onInputSettings, openDesktop, openHub, openExt, openLocal],
  );
  const [toast, setToast] = useToast();
  // 不论从哪个入口回到主标签（顶栏 / 快捷键 / 侧栏 / 分叉后），都把当前会话恢复成 Nomi 会话
  useRestoreNomiOnMain(
    tabs.activeTabId,
    () => ipcClient.conversationStore?.(),
    () => actions.loadChatHistory(),
  );
  // 输入草稿按会话隔离（空会话共用一份，发出后按会话 / 标签各存一份）
  const drafts = useSessionComposerDrafts();
  // 输入框上方的待发列表（插入 / 排队，见 utils/pendingSends）：存在当前 Nomi 会话的元信息里，重启后恢复
  const viewConvoId = useAiChatSelector(selectViewConvoId);
  const pendingStore = ipcClient.conversationStore?.();
  const pendingConvoId = useMemo(() => {
    // 回到空会话 / 正在回复的会话时 viewConvoId 可能还没有：之前的列表归它（发送时才生成 id，之后从 meta 接管）
    const a = pendingStore?.get?.(viewConvoId);
    if (viewConvoId && a?.backend === 'nomi' && !a.tabId) return viewConvoId;
    return viewConvoId === undefined ? nomiSessionId : undefined;
  }, [pendingStore, viewConvoId, nomiSessionId]);
  const pendingSource = useCallback(
    () => ({ store: ipcClient.conversationStore?.(), ipc: ipcClient }),
    [ipcClient],
  );
  const pending = useComposerPending(actions, busyHere, pendingConvoId, {
    convoId: pendingConvoId,
    source: pendingSource,
  });

  const { enqueue } = pending.nomiQueue;
  const enqueueNomi = useCallback((text: string) => enqueue(text, { mode: 'queue' }), [enqueue]);

  // 首屏后空闲时预取设置 / 面板 chunk（不占首屏，打开时无需等待）
  useEffect(() => {
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: object) => number })
      .requestIdleCallback;
    const id = ric
      ? ric(prefetchPanels, { timeout: 2000 })
      : window.setTimeout(prefetchPanels, 500);
    return () => {
      if (ric) (window as { cancelIdleCallback?: (n: number) => void }).cancelIdleCallback?.(id);
      else window.clearTimeout(id);
    };
  }, []);
  // mascot holds a thinking pose while a reply is being generated (semantic event)
  useEffect(() => {
    if (!isLoading) return;
    onboardingClient.mascot({ type: 'reply', phase: 'waiting' });
    return () => onboardingClient.mascot({ type: 'reply', phase: 'settled' });
  }, [isLoading]);
  useEffect(() => watchNomiModel(), []);
  // 装了 agent 才显示 agent 相关界面（没有「对话 / 工坊」切换）
  useEffect(() => watchCliPresence(), []);
  // 没有 agent（如被卸载）时若正停在 CLI 标签，回到主对话（后台标签继续跑）
  useEffect(() => {
    if (!isDev && tabs.isCliTab) void tabs.activate('main');
  }, [isDev, tabs.isCliTab, tabs]);

  const {
    slash,
    backend: slashBackend,
    cwd: slashCwd,
  } = useAppSlash({
    isDev,
    tabs,
    harness,
    ipcClient,
    firstMessageId,
    actions,
    busyHere,
    enqueue: enqueueNomi,
    cliContextMessages,
    nomiMessages,
    panels,
  });
  /**
   * 空会话（新窗口 / 当前会话没发过消息）：整块居中（欢迎区 + 聊天框 + 模型引导）。
   * 口径与 ChatBody 的空态判定保持一致：CLI 标签看标签消息，主对话看 Nomi 消息与斜杠卡。
   */
  const chatEmpty =
    slash.cards.length === 0 &&
    (tabs.isCliTab ? cliConvMessages.length === 0 : nomiMessages.length === 0);
  /** 空会话的 Nomi 主对话：示例问题卡片与输入框缺省文案只在它成立时出现（agent 标签不参与） */
  const nomiEmpty = chatEmpty && !tabs.isCliTab;
  const commands = useAppCommands({
    actions,
    ipcClient,
    tabs,
    isDev,
    panels,
    setToast,
    cwd: rail.cwd,
    toggleTabs: pane?.togglePane,
  });

  // 主区整页（任务 / Agent 看板 / 素材库）：入口在左侧导航栏，三个互斥
  const mainPages = useMainPages(
    () => panels.openSettings('knowledge', 'schedule'),
    closeSettings,
    !!panels.settings,
    paneActions,
  );
  const { openPage, leave: leavePage, openTask } = mainPages;
  const leaveSettingsPage = useCallback(() => {
    closeSettings();
    leavePage();
  }, [closeSettings, leavePage]);
  const openIslandTask = useCallback(
    (id: string) => {
      closeSettings();
      openTask?.(id);
    },
    [closeSettings, openTask],
  );
  const openIslandConversation = useCallback(
    (id: string) => {
      actions.clearDone?.(id);
      const switched =
        id !== ipcClient.currentConversationId?.()
          ? ipcClient.switchConversation(id).then(() => actions.loadChatHistory())
          : Promise.resolve();
      void switched
        .then(() => {
          notifyConversationsChanged();
        })
        .catch(() => undefined);
    },
    [actions, ipcClient],
  );
  const openIslandTab = useCallback(
    (tabId: string) => {
      const store = ipcClient.conversationStore?.() as ConversationStore | undefined;
      const meta = store?.list().find((c) => c.tabId === tabId);
      if (!meta || meta.id === ipcClient.currentConversationId?.()) return;
      void ipcClient
        .switchConversation(meta.id)
        .then(() => {
          notifyConversationsChanged();
        })
        .catch(() => undefined);
    },
    [ipcClient],
  );
  const mainHidden = openPage !== null;
  const setHostSuspended = pane?.setHostSuspended;
  useEffect(() => {
    setHostSuspended?.(mainHidden || !!panels.settings);
  }, [setHostSuspended, mainHidden, panels.settings]);
  // 灵动岛上点「打开」/ 点某一条：跳到任务详情 / agent 标签 / 主对话（含指定会话）
  useIslandOpenItem(openIslandTask, leaveSettingsPage, openIslandConversation, openIslandTab);
  // 「回到原会话」：切到预览所属的那个 Nomi 会话；预览就属于当前会话（只是工作区换了）或不是 Nomi 会话时，
  // 切过去也解不开，只能关掉这些对不上的预览
  const returnToPreviewScope = useCallback(() => {
    const blocked = resourcePreview.sendBlocked;
    const id = blocked && blocked.previewId !== blocked.scopeId ? blocked.previewId : '';
    const conversationId = id.startsWith('nomi:') ? id.slice('nomi:'.length) : '';
    if (conversationId) void ipcClient?.switchConversation?.(conversationId);
    else resourcePreview.closeEntries(resourcePreview.entries.map((entry) => entry.key));
  }, [ipcClient, resourcePreview]);
  const hasOpenWorkspaceInCurrent = side.mounted || resourcePreview.entries.length > 0;
  const handleNewChat = useCallback(
    (opts?: { projectId?: string | null }) => {
      leaveSettingsPage();
      const notReuse = hasOpenWorkspaceInCurrent && nomiSessionId ? [nomiSessionId] : undefined;
      return actions.newConversation({ ...opts, ...(notReuse ? { notReuse } : {}) });
    },
    [actions, leaveSettingsPage, hasOpenWorkspaceInCurrent, nomiSessionId],
  );

  // ───── stable props for the memoized composer ─────
  const cliActive = isDev && tabs.isCliTab ? tabs.activeTab : null;
  const cliReadiness = useCliTabReadiness(cliActive);
  const cliEmpty = chatEmpty && !!cliActive;
  // 能不能附图看这个会话当前用的模型（dsh 例外：命令行没有图片输入）
  const cliImages = useCliImageSupport(cliActive);
  const tabSend = tabs.send;
  // 只依赖用到的原始字段：当前标签的 updatedAt / unread 等变化不重建 props，MessageInput 的 memo 才守得住
  const cliBusy = !!cliActive && (cliActive.status === 'running' || cliActive.status === 'queued');
  const cliPlaceholder = cliActive ? cliTabPlaceholder(cliActive) : undefined;
  const hasCliActive = !!cliActive;
  const cliReadinessStatus = cliReadiness.status;
  const cliReadinessReason = cliReadiness.reason;
  const onCliBeforeSend = useMemo(() => {
    if (!hasCliActive || !cliTabId) return undefined;
    return () => {
      if (cliReadinessStatus === 'needs-model') {
        openModelMenu(cliTabId);
        setToast(t('ui.models.cli-pick-model-before-send'));
        return false;
      }
      if (cliReadinessStatus === 'needs-setup') {
        document.querySelector<HTMLElement>('[data-testid="cli-welcome-configure"]')?.focus();
        setToast(cliReadinessReason ?? t('ui.models.cli-welcome-setup-title'));
        return false;
      }
      return true;
    };
  }, [hasCliActive, cliTabId, cliReadinessStatus, cliReadinessReason, setToast]);
  // First CLI send (no messages yet): arm smart title for third-party gateway models.
  const cliFresh = hasCliActive && tabs.messages.length === 0;
  const inputModeProps = useMemo(
    () =>
      hasCliActive
        ? {
            onBeforeSend: onCliBeforeSend,
            onSend: (text: string, images?: ImageAttachment[]) => {
              void (async () => {
                const imgs = images?.length ? await toHarnessImages(images) : undefined;
                let failed = false;
                await tabSend(text, imgs, undefined, (msg) => {
                  failed = true;
                  setToast(msg);
                });
                if (!failed && cliActive && cliFresh) void smartTitleOnFirstSend(cliActive, text);
              })();
            },
            busyOverride: cliBusy,
            imageCapability: cliImages.capability,
            imageUnsupportedReason: cliImages.reason,
            placeholder: cliPlaceholder,
            queue: pending.queueProps,
          }
        : {
            queue: pending.queueProps,
            // 空会话主对话：把「输入 / 查看命令 · 点击 + 添加更多」当缺省展示值
            ...(nomiEmpty
              ? {
                  placeholder: t('ui.foundation.type-for-commands-for-knowledge-base-voice-models'),
                }
              : {}),
          },
    [
      hasCliActive,
      onCliBeforeSend,
      cliActive,
      cliFresh,
      cliBusy,
      cliPlaceholder,
      cliImages,
      tabSend,
      setToast,
      pending.queueProps,
      nomiEmpty,
    ],
  );

  // 详情与文件栏开关：桌面应用在标题栏右侧，更多操作与详细程度归入左侧标题下拉
  const titleBar = hasAppTitleBar();
  const sideMaximized = side.maximized;
  const restoreSide = side.restore;
  const toggleSidePane = useCallback(() => {
    // 全屏状态下先退出全屏，再隐藏工作区；否则只改可见偏好，最大化状态会把它重新顶回来。
    if (sideMaximized) {
      restoreSide();
      pane?.hidePane?.();
      return;
    }
    pane?.togglePane();
  }, [pane, restoreSide, sideMaximized]);
  // 对话旁那一栏：子任务 / 文件标签，或右栏的未提交文件预览（挂载点）
  const centerOpen = side.open;
  const centerP = usePresence(centerOpen, 205);
  const centerRendered = !!centerP.value;
  const sideMax = centerOpen && side.maximized;
  // 铺满时向右拆分：左主会话、右当前标签，中间分割线
  const sideSplit = sideMax && side.split;
  const mainShown = !sideMax || sideSplit || side.active === MAIN_SIDE_TAB;
  const sessionTools = (
    <SessionTools
      messages={rail.messages}
      rail={pane ? { open: side.open, onToggle: toggleSidePane } : null}
      hideDetails={sideMax}
    />
  );
  const mainContentRef = useRef<HTMLDivElement>(null);
  const chatColumnRef = useRef<HTMLDivElement>(null);
  useWorkspaceLayoutMotion({
    mainRef: mainContentRef,
    maximized: sideMax,
    split: sideSplit,
    open: centerOpen,
    closing: centerP.closing,
    chatRatio: split.chatColumn.ratio,
  });
  /**
   * 一列会话（对话头 / 待带入前文条 / 会话主体 / 输入框）。单面板时是唯一的一列；
   * 并排时左右各一列，焦点那一列（owned）带整列级的窗口组件：提交按钮下面的授权卡、会话详情、
   * ManagedRuntime 的按当前会话的观察——它们都只认一个「当前会话」，不能两边各挂一份。
   */
  const renderChatColumn = (opts: {
    hidden: boolean;
    withSidePane: boolean;
    /** 并排会话：列更窄，最小宽度比单面板时小 */
    splitPanes?: boolean;
  }): React.ReactNode => {
    const inner = (
      <>
        {/* 桌面应用里会话名与工具在标题栏（与对话卡片对齐）；浏览器里没有标题栏，留一行顶栏 */}
        {!titleBar && (
          <ChatHeader
            title={<SessionTitle onFork={commands.onForkRequest} />}
            trailing={sessionTools}
          />
        )}
        {/* 待带入的新会话前文属于当前对话状态，放在对话区顶部，避免和输入工具混在一起。 */}
        <div className="session-bar chat-session-bar">
          <SessionControls />
        </div>
        {/* 会话详情始终浮在对话列右上角，不参与分栏 */}
        {!mainHidden && <SessionDetailsDock overlay messages={rail.messages} cwd={rail.cwd} />}
        <ManagedRuntimeProvider conversationId={nomiSessionId} hidden={tabs.isCliTab}>
          <main className="chat-container">
            {/* 每条回复末尾的「分叉」：从这条回复往前分叉，之后的消息不带 */}
            <ForkFromMessageContext.Provider value={commands.forkFromMessage}>
              <ChatBody
                tabs={tabs}
                isDev={isDev}
                sessionKey={sessionKey}
                cliMessages={cliConvMessages}
                nomiMessages={nomiMessages}
                slash={slash}
              />
            </ForkFromMessageContext.Provider>
          </main>

          <footer className="input-container" ref={resourcePreview.composerRef}>
            {/* 正在操作桌面（Nomi / agents）：紧急停止 */}
            <ComputerActivityBar />
            {/* Nomi 桌面工具的授权卡片：对话窗口开着时确认请求只发到这里（整个窗口一份，归当前会话那一列） */}
            <DesktopConfirmDock />
            <UserQuestionDock
              conversationId={tabs.isCliTab ? undefined : nomiSessionId}
              tabId={tabs.isCliTab ? tabs.activeTab?.id : undefined}
            />
            <PendingDock
              items={pending.items}
              onWithdraw={pending.onWithdraw}
              onRemove={pending.onRemove}
              onFlush={pending.canFlush ? pending.onFlush : undefined}
              failure={pending.failure}
              failedText={pending.failedText}
              failedId={pending.failedId}
              onRetry={pending.onRetry}
              onSendTextOnly={pending.onSendTextOnly}
            />
            {/* 新会话：输入框上方的项目 · 分支，可以自由切换 */}
            <NewChatContext />
            <ManagedRuntimeDock />
            {/* 预览属于别的会话 / 工作区时输入框不能用：必须说明原因，并能一键回到原会话（空会话时贴在输入框下沿） */}
            {resourcePreview.sendBlocked && (
              <SendBlockedHint
                reason={resourcePreview.sendBlocked}
                floating={chatEmpty}
                onReturn={returnToPreviewScope}
              />
            )}
            <MessageInput
              {...inputModeProps}
              disabled={resourcePreview.sendMismatch}
              cwd={rail.cwd ?? undefined}
              roots={rail.roots}
              delegate={slashBackend === 'nomi'}
              contextMessages={tabs.isCliTab ? cliContextMessages : nomiMessages}
              contextModel={
                tabs.isCliTab
                  ? (tabs.activeTab?.modelOverride ??
                    liveContext?.model ??
                    reportedModel(cliConvMessages) ??
                    tabs.activeTab?.backend)
                  : undefined
              }
              slash={slash.bridge}
              fill={composerFill}
              dropZoneRef={chatColumnRef}
              dropEvent={CHAT_DROP_FILE_PATH_EVENT}
              draftStore={drafts.draftStore}
              draftKey={drafts.draftKey}
              // 只在 agent 标签里：Nomi 自己的 Skills / MCP 在「扩展」里管理
              onPluginsClick={slashBackend !== 'nomi' ? panels.openPlugins : undefined}
              onProvidersClick={panels.openProviders}
              onSettingsClick={panels.onInputSettings}
              onDesktopClick={panels.openDesktop}
              onHubClick={panels.openHub}
              onExtClick={panels.openExt}
              onLocalClick={panels.openLocal}
            />
            {/* 空会话主对话、输入框下方：缺模型时常驻「添加 / 选择模型」引导卡，否则是示例问题卡片；
                      Agents 标签未选模型或未配置账号时在对应位置展示引导卡 */}
            {nomiEmpty && <WelcomeActions onOpenModels={panels.openProviders} />}
            {cliEmpty && cliActive && (
              <CliWelcomeActions
                tab={cliActive}
                readiness={cliReadiness}
                onPickModel={() => {
                  if (!openModelMenu(cliActive.id)) {
                    setToast(t('ui.models.cli-pick-model-before-send'));
                  }
                }}
                onOpenSetup={() => panels.onInputSettings('ai', cliActive.backend, 'assistants')}
                onOpenProviders={panels.openProviders}
              />
            )}
          </footer>
        </ManagedRuntimeProvider>
      </>
    );
    return (
      <ChatColumn
        key="chat-column"
        columnRef={chatColumnRef}
        hidden={opts.hidden}
        // 空会话：整块居中（欢迎区 + 输入框），见 App.css 的 [data-empty]
        empty={chatEmpty}
        withSidePane={opts.withSidePane}
        minWidth={opts.splitPanes ? 'var(--cd-chat-col-min-split)' : undefined}
      >
        {inner}
      </ChatColumn>
    );
  };

  // ───── 并排会话的布局 ─────
  // 单面板时与原来一致（有中栏 / 文件时才分栏）；并排时总是 [会话 | 会话] 再与唯一的文件区分栏
  const paneLayout = useSessionPaneLayout({
    singlePaneWithSide: centerOpen && !sideMax,
    tabOf: paneTabOf,
  });
  const splitter = (
    <div
      key="session-pane-splitter"
      className="session-pane-splitter"
      data-testid="session-pane-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('ui.session-panes.handle')}
      aria-valuenow={Math.round(paneLayout.ratio * 100)}
      aria-valuemin={Math.round(PANE_RATIO_MIN * 100)}
      aria-valuemax={Math.round(PANE_RATIO_MAX * 100)}
      onPointerDown={paneLayout.onPointerDown}
      onDoubleClick={paneLayout.onDoubleClick}
    />
  );

  return (
    <SelectionActionsContext.Provider value={selectionActions}>
      <ResourceScopeProvider value={resourcePreview.value}>
        <SelectionToolbar />
        <div className="ai-chat-app">
          <ChatBackgroundLayer />
          <StartupReady />
          <AppTitleBar
            sidebarCollapsed={panels.sidebarCollapsed}
            filesOpen={!panels.settings && !mainHidden && rail.open}
            centerOpen={!panels.settings && !mainHidden && centerOpen && !sideMax}
            layoutKey={`${panels.settings}:${openPage}:${sideMax}:${sideSplit}:${details?.visible}`}
            onToggleSidebar={panels.toggleSidebar}
            title={
              panels.settings ? null : (
                <TitleBarTitle page={openPage} onFork={commands.onForkRequest} />
              )
            }
            trailing={
              titleBar ? (
                <>
                  {/* 更新已下载好：设置页外在标题栏提示「重启更新」（设置页里在导航底部） */}
                  {!panels.settings && <RestartUpdateButton placement="titlebar" />}
                  {!panels.settings && !mainHidden && sessionTools}
                </>
              ) : undefined
            }
            lead={titleBar && !panels.settings ? mainPages.fleetIndicator : undefined}
          />
          <Sidebar
            collapsed={panels.sidebarCollapsed}
            panelHidden={!!panels.settings}
            onToggle={panels.toggleSidebar}
            onNewChat={handleNewChat}
            onForkRequest={commands.onForkRequest}
            onNotice={setToast}
            onOpenSettings={panels.openSettings}
            footer={panels.sidebarFooter}
            pageOpen={mainHidden || !!panels.settings}
            onLeavePage={leaveSettingsPage}
            topNav={mainPages.topNav}
            onOpenTask={mainPages.openTask}
            onOpenAsset={mainPages.openAsset}
            onOpenToSide={openSessionToSide}
            onOpenInFocus={openSessionInFocus}
          />

          {/* 对话区（对话 / 中栏 / 任务 / 素材库 / 右栏）是白色圆角卡片；会话面板展开时是它左边的灰色半张 */}
          <div className="workspace-card" data-testid="workspace-card">
            {/* 会话内容保活：设置只替换展示区域，草稿、滚动与订阅保留。 */}
            <div className={panels.settings ? 'chat-keepalive-hidden' : 'chat-keepalive'}>
              {/* 主内容：无查看区时对话全宽；有本会话 Diff 或右栏文件预览时 chat-column | 中栏 横排全高 */}
              <div
                ref={mainContentRef}
                className={`main-content${centerRendered ? ' main-content--with-changes' : ''}${sideMax ? ' main-content--side-max' : ''}${sideSplit ? ' main-content--side-split' : ''}`}
                data-with-changes={centerOpen ? 'true' : undefined}
                data-side-max={sideMax ? 'true' : undefined}
                data-side-main={sideMax && !sideSplit && mainShown ? 'true' : undefined}
                style={
                  sideSplit
                    ? ({ '--side-split': `${side.splitRatio * 100}%` } as React.CSSProperties)
                    : centerRendered && !sideMax
                      ? ({
                          '--chat-col-grow': split.chatColumn.ratio,
                          '--side-pane-grow': 1 - split.chatColumn.ratio,
                        } as React.CSSProperties)
                      : undefined
                }
                hidden={mainHidden}
              >
                {/* 铺满时标签栏在整个对话区顶上，主会话是第一个标签（不能关） */}
                {sideMax && (
                  <SideTabStrip
                    model={side}
                    columnMessages={rail.messages}
                    actionsInTitlebar={!panels.settings && !mainHidden}
                  />
                )}
                {/* 主区里的会话：单面板时就是原来那一列；「向右打开」后左右并排，中间可拖（App.css 的 .session-panes）。
                    DOM 严格按左→右：pane-a、分割线、pane-b（焦点在右边时也不换顺序，否则视觉左右反了）。
                    并排不换掉任何一边的会话，也不影响右边唯一的工作区。 */}
                <div
                  className={`session-panes${paneLayout.split ? ' session-panes--split' : ''}`}
                  data-testid="session-panes"
                  data-split={paneLayout.split ? 'true' : undefined}
                  data-with-changes={paneLayout.withSidePane ? 'true' : undefined}
                  style={paneLayout.style}
                >
                  {paneLayout.columns.map((column, index) => {
                    const focused = column.focus;
                    // 焦点面板 = 「当前会话」：就是 App 原来那一列（对话头、前文条、会话详情、授权卡、输入框、
                    // 回到预览所在会话的提示都只在这里）；非焦点面板按它自己绑定的会话只读展示。
                    const body = focused ? (
                      renderChatColumn({
                        hidden: !mainShown,
                        withSidePane: paneLayout.withSidePane,
                        // 并排时这一列只有一半宽；不跟文件区分栏时列更窄，最小宽度再收一档（窄窗口也排得开）
                        splitPanes: paneLayout.split && !paneLayout.withSidePane,
                      })
                    ) : (
                      <PaneSessionView sessionKey={column.key}>
                        {(view) => (
                          <ChatColumn
                            hidden={!mainShown}
                            empty={!view.hasMessages}
                            withSidePane={paneLayout.withSidePane}
                            minWidth={
                              paneLayout.split && !paneLayout.withSidePane
                                ? 'var(--cd-chat-col-min-split)'
                                : undefined
                            }
                          >
                            <PaneChatColumnBody view={view} paneId={column.paneId} />
                          </ChatColumn>
                        )}
                      </PaneSessionView>
                    );
                    return (
                      <React.Fragment key={column.paneId}>
                        {index > 0 && paneLayout.split && splitter}
                        <SessionPane
                          paneId={column.paneId}
                          index={index}
                          header={paneLayout.split}
                          tabOf={paneLayout.tabOf}
                        >
                          {body}
                        </SessionPane>
                      </React.Fragment>
                    );
                  })}
                </div>

                {sideSplit && (
                  <SideSplitHandle ratio={side.splitRatio} onRatio={side.setSplitRatio} />
                )}
                {resourcePreview.overlays}
                {centerRendered ? (
                  <>
                    <div
                      hidden={sideMax || centerP.closing}
                      className="center-changes-splitter"
                      data-testid="center-changes-splitter"
                      role="separator"
                      aria-orientation="vertical"
                      aria-valuenow={Math.round(split.chatColumn.ratio * 100)}
                      aria-valuemin={Math.round(CHAT_COL_RATIO_MIN * 100)}
                      aria-valuemax={Math.round(CHAT_COL_RATIO_MAX * 100)}
                      onPointerDown={split.chatColumn.onPointerDown}
                      onDoubleClick={split.chatColumn.onDoubleClick}
                      title={t('ui.session-workspace.drag-to-resize-chat-and-diff-double-click')}
                    />
                    <SideWorkspace
                      model={side}
                      messages={rail.messages}
                      cwd={rail.cwd}
                      roots={rail.roots}
                      projectId={rail.projectId}
                      projectPrimary={rail.projectPrimary}
                      busy={rail.busy}
                      actions={paneActions}
                      showStrip={!sideMax && !centerP.closing && !panels.settings && !mainHidden}
                      closing={centerP.closing}
                    />
                  </>
                ) : side.mounted ? (
                  <div hidden>
                    <SideWorkspace
                      model={side}
                      messages={rail.messages}
                      cwd={rail.cwd}
                      roots={rail.roots}
                      projectId={rail.projectId}
                      projectPrimary={rail.projectPrimary}
                      busy={rail.busy}
                      actions={paneActions}
                      showStrip={false}
                    />
                  </div>
                ) : null}
              </div>
              {/* 整页（素材库 / 任务 / Agent 看板）：替换对话区（对话区只隐藏不卸载），侧栏保持 */}
              {mainPages.pages}
            </div>
            {panels.settings && (
              <div className="settings-workspace" data-testid="settings-workspace">
                <SettingsView
                  section={panels.settings}
                  deepLink={panels.settingsLink}
                  onSection={panels.setSettings}
                  onClose={panels.closeSettings}
                  collapsed={panels.sidebarCollapsed}
                />
              </div>
            )}
          </div>

          <AppOverlays
            panels={panels}
            commands={commands}
            slash={slash}
            slashBackend={slashBackend}
            slashCwd={slashCwd}
            toast={toast}
          />
        </div>
      </ResourceScopeProvider>
    </SelectionActionsContext.Provider>
  );
};

// 在 <AIProvider> 缺失时也不抛错：直接读 AISdkReact 未导出的内部 Context 是不推荐的，
// 因此改用 try/catch 包装 useAIClient，返回 undefined 让 AiChatContextProvider 走本地 Mock 分支。
function useOptionalAIClient(): ClientAIClient | undefined {
  const hook = (AISdkReact as { useAIClient?: () => ClientAIClient }).useAIClient;
  if (!hook) return undefined;
  try {
    return hook();
  } catch {
    return undefined;
  }
}

const ScopedWorkspacePanes: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { sessionKey } = useActiveSessionInfo();
  return <WorkspacePanesProvider scope={sessionKey}>{children}</WorkspacePanesProvider>;
};

/**
 * 主区的会话面板（并排会话）：挂在侧栏与主区外面，两者共用同一份面板状态。
 *
 * - 焦点面板 = 「当前会话」：聚焦别的面板、侧栏单击、侧栏 / 标题菜单里点会话、轨迹时间线里点会话，
 *   都先把「当前会话」同步到焦点面板（syncCurrentToPane），于是发送、斜杠命令、整列级组件都沿用原来的路径；
 * - 当前会话在别处变了（新建对话、关掉 CLI 标签、灵动岛跳转）：把焦点面板指过去（seed）。已拆分且这个会话
 *   已经开在另一个面板里时 seed 不动，两个面板各显示各的；
 * - CLI 标签关掉 / 标签列表里没有了：把它从面板里摘掉（dropSession），并排退回单面板。
 * 侧栏与主区里的文件区（SideWorkspace）都在这下面：并排时仍只有唯一一份。
 */
const SessionPanesHost: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { activeTabId: currentTabId, activate: activateTab } = useHarnessTabsCore();
  const syncFocus = useCallback(
    (
      sessionKey: string | null,
      deps: Omit<SyncPaneDeps, 'currentTabId' | 'activateTab' | 'hasTabs'>,
    ) => {
      syncCurrentToPane(sessionKey, {
        ...deps,
        currentTabId,
        activateTab,
        hasTabs: !!deps.tabList,
      });
    },
    [currentTabId, activateTab],
  );
  return (
    <SessionPanesProvider>
      <SessionPanesSync syncFocus={syncFocus}>{children}</SessionPanesSync>
    </SessionPanesProvider>
  );
};

export interface SyncPaneDeps {
  store: ConversationStore | undefined;
  /** harness 标签列表（还没拿到时为 undefined：不按它摘面板） */
  tabList: readonly HarnessTabMeta[] | undefined;
  tabIdOf: (key: string) => string | undefined;
  currentTabId: string | undefined;
  activateTab: (id: string) => void;
  hasTabs: boolean;
}

/**
 * 面板与「当前会话」的双向同步（在 SessionPanesProvider 里面）：
 * - 焦点面板变了 → 当前会话跟过去（侧栏单击、聚焦另一面板、轨迹时间线切会话）；
 * - 当前会话在别处变了（新建对话、关掉 CLI 标签、灵动岛跳转、冷启动）→ seed 到焦点面板
 *   （已拆分且这个会话已开在某个面板里时不动）；
 * - 会话没了（Nomi 被删 / 归档、CLI 标签关掉）→ 从面板里摘掉。
 */
const SessionPanesSync: React.FC<{
  syncFocus: (
    key: string | null,
    deps: Omit<SyncPaneDeps, 'currentTabId' | 'activateTab' | 'hasTabs'>,
  ) => void;
  children: React.ReactNode;
}> = ({ syncFocus, children }) => {
  const panes = useSessionPanes();
  const ipcClient = useAiChatSelector(selectIpcClient);
  const store = ipcClient?.conversationStore?.() as ConversationStore | undefined;
  const tabList = useHarnessTabs().state?.tabs;
  const tabIdOf = useCallback(
    (key: string) => tabOfSessionKey(tabList, key)?.id ?? tabIdOfSessionKey(key),
    [tabList],
  );
  // 只发布稳定的回调，状态经 ref 读：Provider 的 onFocusSession / seed 引用不变
  const deps = useMemo(
    () => ({
      store,
      tabList,
      tabIdOf,
    }),
    [store, tabList, tabIdOf],
  );
  // onFocusSession：Provider 在 setState 的更新函数里调用它，只同步指针、不在这里 setState
  const prevFocusRef = useRef<string | null>(null);
  const onFocus = panes?.focusedKey ?? null;
  useLayoutEffect(() => {
    if (onFocus === prevFocusRef.current) return;
    prevFocusRef.current = onFocus;
    syncFocus(onFocus, deps);
  }, [onFocus, syncFocus, deps]);
  // 当前会话变了：焦点面板跟过去
  const currentSnapshot = useCurrentSessionSnapshot();
  const seed = panes?.seed;
  // 当前会话的指针：store 的 currentId 变化会经 CONVERSATIONS_CHANGED_EVENT 让上面的快照重读，
  // 标签变化是 harness 上下文的新对象
  const currentKey = currentSnapshot();
  useLayoutEffect(() => {
    seed?.(currentKey);
  }, [currentKey, seed, currentSnapshot]);
  // 会话没了：从面板里摘掉
  const dropSession = panes?.dropSession;
  const paneKeys = paneKeysKey(panes?.panes ?? []);
  useEffect(() => {
    if (!dropSession) return;
    for (const key of paneKeys.split('\u0000')) {
      const parsed = parseSessionKey(key);
      if (!parsed) continue;
      if (parsed.kind === 'nomi') {
        if (store && !store.get(parsed.id)) dropSession(key);
      } else if (tabList && !tabOfSessionKey(tabList, key)) dropSession(key);
    }
  }, [paneKeys, store, tabList, dropSession]);
  return <>{children}</>;
};

function App() {
  const client = useOptionalAIClient();
  return (
    <ErrorBoundary>
      <AiChatContextProvider client={client}>
        <HarnessTabsProvider>
          <SessionPanesHost>
            <ScopedWorkspacePanes>
              <TitlebarPanelsProvider>
                <AiChatContent />
              </TitlebarPanelsProvider>
            </ScopedWorkspacePanes>
          </SessionPanesHost>
        </HarnessTabsProvider>
        {/* 首次启动引导（未完成时覆盖在对话窗口上；设置 → 通用 可重新打开） */}
        <OnboardingHost />
        <ReleaseNotesHost />
        <ProviderLinkHost />
      </AiChatContextProvider>
    </ErrorBoundary>
  );
}

export default App;
