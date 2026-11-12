import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import * as AISdkReact from '@nomi-ai/ai-sdk-client/react';
import { t, usePresence } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useMemo } from 'react';

import { AppOverlays, useToast } from './app/AppOverlays';
import { ChatBody } from './app/ChatBody';
import { FilesRail } from './app/FilesRail';
import { useAppCommands } from './app/useAppCommands';
import { useAppPanels } from './app/useAppPanels';
import { useAppSlash } from './app/useAppSlash';
import { useCliContext } from './app/useCliContext';
import { useRail } from './app/useRail';
import { useSplitWidths } from './app/useSplitWidths';
import { ChatBackgroundLayer } from './components/ChatBackground/ChatBackgroundLayer';
import { ChatHeader } from './components/ChatHeader';
import { ComputerActivityBar } from './components/ComputerActivityBar';
import { ForkFromMessageContext } from './components/Conversation/forkContext';
import { DesktopConfirmDock } from './components/DesktopConfirmDock';
import { NewChatContext, SessionControls } from './components/EndpointControls';
import { ErrorBoundary } from './components/ErrorBoundary';
import { prefetchPanels } from './components/lazyPanels';
import { MessageInput } from './components/MessageInput';
import { onboardingClient } from './components/Onboarding/client';
import { OnboardingHost } from './components/Onboarding/host';
import { PendingDock } from './components/PendingDock';
import { usePreviewChatWindow } from './components/PreviewChat/usePreviewChatWindow';
import { ProviderLinkHost } from './components/ProviderLink';
import { ReleaseNotesHost } from './components/ReleaseNotesModal';
import { RestartUpdateButton } from './components/RestartUpdateButton';
import { SessionDetailsDock } from './components/SessionDetails';
import { useChangesUi } from './components/SessionWorkspace';
import { Sidebar } from './components/Sidebar';
import { SideColumn, WorkspacePanesProvider } from './components/SubagentPane';
import { AppTitleBar, hasAppTitleBar } from './components/TitleBar';
import { SessionTools, TitleBarTitle } from './components/TitleBar/SessionTitle';
import { AiChatContextProvider } from './contexts/AiChatContext';
import type { AiChatState } from './contexts/AiChatContext';
import {
  selectFirstMessageId,
  selectBusyHere,
  selectIpcClient,
  selectIsLoading,
  selectViewConvoId,
  shallowArrayEqual,
  useAiChatActions,
  useAiChatSelector,
} from './contexts/aiChatStore';
import { HarnessTabsProvider, useHarnessTabsCore } from './contexts/HarnessTabsContext';
import { ResourceScopeProvider } from './contexts/ResourceContext';
import { useChatMode } from './hooks/useChatMode';
import { useComposerPending } from './hooks/useComposerPending';
import { useHarnessState } from './hooks/useHarnessState';
import { useIslandOpenItem } from './hooks/useIslandOpenItem';
import { useMainPages } from './hooks/useMainPages';
import { useResourcePreview } from './hooks/useResourcePreview';
import { useRestoreNomiOnMain } from './hooks/useRestoreNomiOnMain';
import { useSessionComposerDrafts } from './hooks/useSessionComposerDrafts';
import { useMigrateCliTranscriptView } from './hooks/useTranscriptView';
import { toHarnessImages } from './services/chatImages';
import { watchCliPresence } from './services/cliPresence';
import { smartTitleOnFirstSend } from './services/cliSmartTitle';
import { watchNomiModel } from './services/nomiModel';
import type { ImageAttachment } from './services/screenClient';
import { cliTranscriptKey } from './services/transcriptView';
import { reportedModel } from './slash/tokens';
import { CHAT_COL_W_MAX, CHAT_COL_W_MIN } from './utils/chatColumnWidth';
import { useCliImageSupport } from './utils/cliImageSupport';
import { cliTabPlaceholder } from './utils/cliTabPlaceholder';
import { fromHarnessMessage, nomiConvMessages, settledNomiMessages } from './utils/convAdapters';
import './App.css';

const selectSettledNomi = (s: AiChatState) => settledNomiMessages(s.messages, selectBusyHere(s));

/**
 * 对话窗口的组装：侧栏 | 对话卡片（对话列、中栏、会话详情、整页、右栏）+ 覆盖层。
 * 各部分的状态在 app/ 下的 hook 里；这里只订阅需要的切片：流式输出的一帧只改最后一轮，
 * 由 NomiConversation（app/ChatBody）自己订阅，App 与其余部分不跟着重渲染。
 */
const AiChatContent: React.FC = () => {
  const split = useSplitWidths();
  const { composerFill } = useChangesUi();
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
  // 当前会话的键：CLI 标签用 tab:<id>，Nomi 对话用 nomi:<conversationId>；
  // Transcript view 按这个键分开保存，切换会话互不影响。
  const viewConvoId = useAiChatSelector(selectViewConvoId);
  const nomiSessionId = viewConvoId ?? ipcClient?.currentConversationId?.();
  const sessionKey =
    isDev && tabs.isCliTab && tabs.activeTab
      ? cliTranscriptKey(tabs.activeTab)
      : nomiSessionId
        ? `nomi:${nomiSessionId}`
        : null;
  // 编程助手标签拿到会话 id 后，把按标签存的 Transcript view 覆盖搬到会话键（关标签、从历史重开也在）
  useMigrateCliTranscriptView(isDev && tabs.isCliTab ? tabs.activeTab : null);
  // ───── 统一会话视图的数据：Nomi 主对话与编程助手标签走同一个 ConversationView ─────
  const nomiMessages = useMemo(() => nomiConvMessages(settledNomi), [settledNomi]);
  const cliBackend = tabs.activeTab?.backend ?? 'claude';
  const cliConvMessages = useMemo(
    () => (tabs.isCliTab ? tabs.messages.map((m) => fromHarnessMessage(m, cliBackend)) : []),
    [tabs.isCliTab, tabs.messages, cliBackend],
  );
  const { liveContext, cliContextMessages } = useCliContext(tabs, cliConvMessages);
  const rail = useRail({ tabs, isDev, harness, busyHere, cliConvMessages, nomiMessages });
  const resourcePreview = useResourcePreview({
    id: isDev && tabs.isCliTab ? `cli:${tabs.activeTabId}` : `nomi:${nomiSessionId ?? ''}`,
    cwd: rail.cwd,
    source: isDev && tabs.isCliTab ? tabs.activeTab?.backend : 'nomi',
  });
  const previewChat = usePreviewChatWindow(
    resourcePreview.isOpen && resourcePreview.expanded,
    resourcePreview.connectConversation,
    resourcePreview.workspaceCwd,
  );
  const panels = useAppPanels();
  const [toast, setToast] = useToast();
  // 不论从哪个入口回到主标签（顶栏 / 快捷键 / 侧栏 / 分叉后），都把当前会话恢复成 Nomi 会话
  useRestoreNomiOnMain(
    tabs.activeTabId,
    () => ipcClient.conversationStore?.(),
    () => actions.loadChatHistory(),
  );
  // 输入草稿按会话隔离（空会话共用一份，发出后按会话 / 标签各存一份）
  const drafts = useSessionComposerDrafts();
  // 输入框上方的待发列表（插入 / 排队，见 utils/pendingSends）
  const pending = useComposerPending(actions, busyHere, firstMessageId);
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
  // 装了编程助手才显示编程助手相关界面（没有「对话 / 工坊」切换）
  useEffect(() => watchCliPresence(), []);
  // 没有编程助手（如被卸载）时若正停在 CLI 标签，回到主对话（后台标签继续跑）
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
  const commands = useAppCommands({
    actions,
    ipcClient,
    tabs,
    isDev,
    panels,
    setToast,
    cwd: rail.cwd,
  });

  // 主区整页（任务 / Agent 看板 / 素材库）：入口在左侧导航栏，三个互斥
  const mainPages = useMainPages(() => panels.openSettings('knowledge', 'schedule'));
  const { openPage, leave: leavePage } = mainPages;
  const mainHidden = openPage !== null;
  // 右栏收起时先放完滑出动画再卸载；切到整页时直接收
  const filesRail = usePresence(rail.open && !!rail.cwd && !mainHidden);
  // 灵动岛上点「打开」/ 点某一条：跳到任务详情 / 编程助手标签 / 主对话
  useIslandOpenItem(mainPages.openTask, leavePage);
  const handleNewChat = useCallback(
    (opts?: { projectId?: string | null }) => {
      leavePage();
      return actions.newConversation(opts);
    },
    [actions, leavePage],
  );

  // ───── stable props for the memoized composer ─────
  const cliActive = isDev && tabs.isCliTab ? tabs.activeTab : null;
  // 能不能附图看这个会话当前用的模型（dsh 例外：命令行没有图片输入）
  const cliImages = useCliImageSupport(cliActive);
  const tabSend = tabs.send;
  // 只依赖用到的原始字段：当前标签的 updatedAt / unread 等变化不重建 props，MessageInput 的 memo 才守得住
  const cliBusy = !!cliActive && (cliActive.status === 'running' || cliActive.status === 'queued');
  const cliPlaceholder = cliActive ? cliTabPlaceholder(cliActive) : undefined;
  const hasCliActive = !!cliActive;
  // First CLI send (no messages yet): arm smart title for third-party gateway models.
  const cliFresh = hasCliActive && tabs.messages.length === 0;
  const inputModeProps = useMemo(
    () =>
      hasCliActive
        ? {
            onSend: (text: string, images?: ImageAttachment[]) => {
              void (async () => {
                const imgs = images?.length ? await toHarnessImages(images) : undefined;
                await tabSend(text, imgs);
              })();
              if (cliActive && cliFresh) void smartTitleOnFirstSend(cliActive, text);
            },
            busyOverride: cliBusy,
            imageCapability: cliImages.capability,
            imageUnsupportedReason: cliImages.reason,
            placeholder: cliPlaceholder,
            queue: pending.queueProps,
          }
        : { queue: pending.queueProps },
    [
      hasCliActive,
      cliActive,
      cliFresh,
      cliBusy,
      cliPlaceholder,
      cliImages,
      tabSend,
      pending.queueProps,
    ],
  );

  // 当前会话的「…」菜单 + 工具栏（改动 · 文件）开关：桌面应用在标题栏右侧，浏览器在对话顶栏
  const titleBar = hasAppTitleBar();
  const sessionTools = (
    <SessionTools
      sessionKey={sessionKey}
      onFork={commands.onForkRequest}
      messages={rail.messages}
      rail={rail.cwd ? { open: rail.open, cwd: rail.cwd, onToggle: rail.toggle } : null}
    />
  );
  const { centerOpen } = rail;

  return (
    <ResourceScopeProvider value={resourcePreview.value}>
      <div className="ai-chat-app">
        <ChatBackgroundLayer />
        <AppTitleBar
          sidebarCollapsed={panels.sidebarCollapsed}
          onToggleSidebar={panels.toggleSidebar}
          title={<TitleBarTitle page={openPage} />}
          trailing={
            titleBar ? (
              <>
                {/* 更新已下载好：设置页外在标题栏提示「重启更新」（设置页里在导航底部） */}
                {!panels.settings && <RestartUpdateButton placement="titlebar" />}
                {!mainHidden && sessionTools}
              </>
            ) : undefined
          }
          lead={titleBar ? mainPages.fleetIndicator : undefined}
        />
        {/* 会话树保活：打开设置时只隐藏（display:none）不卸载，避免关闭时整树冷重挂载导致卡顿、
          草稿/滚动位置丢失与 IPC 订阅重建 */}
        <div className={panels.settings ? 'chat-keepalive-hidden' : 'chat-keepalive'}>
          <Sidebar
            collapsed={panels.sidebarCollapsed}
            onToggle={panels.toggleSidebar}
            onNewChat={handleNewChat}
            onForkRequest={commands.onForkRequest}
            onNotice={setToast}
            onOpenSettings={panels.openSettings}
            footer={panels.sidebarFooter}
            pageOpen={mainHidden}
            onLeavePage={leavePage}
            topNav={mainPages.topNav}
            onOpenTask={mainPages.openTask}
            onOpenAsset={mainPages.openAsset}
          />

          {/* 对话区（对话 / 中栏 / 任务 / 素材库 / 右栏）是白色圆角卡片；会话面板展开时是它左边的灰色半张 */}
          <div className="workspace-card" data-testid="workspace-card">
            {/* 主内容：无查看区时对话全宽；有本会话 Diff 或右栏文件预览时 chat-column | 中栏 横排全高 */}
            <div
              className={`${centerOpen ? 'main-content main-content--with-changes' : 'main-content'} ${resourcePreview.className}`}
              style={resourcePreview.style}
              data-with-changes={centerOpen ? 'true' : undefined}
              hidden={mainHidden}
            >
              <div
                className="chat-column"
                ref={previewChat.ref}
                data-preview-chat-open={previewChat.expanded || undefined}
                data-preview-chat-min={previewChat.minimized || undefined}
                {...previewChat.events}
                data-testid="chat-column"
                style={{
                  ...previewChat.style,
                  ...(centerOpen
                    ? {
                        width: split.chatColumn.width,
                        // 窗口窄时最小宽度随窗口收缩（App.css 的 --cd-chat-col-min），宽屏仍是 CHAT_COL_W_MIN
                        minWidth: 'var(--cd-chat-col-min)',
                        maxWidth: CHAT_COL_W_MAX,
                        // 窗口不够时先压对话列（到最小宽度），不把中栏挤没
                        flexShrink: 1,
                      }
                    : {}),
                }}
              >
                {/* 桌面应用里会话名与工具在标题栏（与对话卡片对齐）；浏览器里没有标题栏，留一行顶栏 */}
                {previewChat.header}
                {!titleBar && <ChatHeader trailing={sessionTools} />}
                {/* 待带入的新会话前文属于当前对话状态，放在对话区顶部，避免和输入工具混在一起。 */}
                <div className="session-bar chat-session-bar">
                  <SessionControls />
                </div>
                {/* 会话详情自动收起后再打开：浮在对话列右上角；文件专注模式下对话列是底部浮窗，不放 */}
                {!mainHidden && !(resourcePreview.isOpen && resourcePreview.expanded) && (
                  <SessionDetailsDock overlay messages={rail.messages} cwd={rail.cwd} />
                )}
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
                      onOpenModels={panels.openProviders}
                    />
                  </ForkFromMessageContext.Provider>
                </main>

                <footer className="input-container" ref={resourcePreview.composerRef}>
                  {/* 正在操作桌面（Nomi / 编程助手）：紧急停止 */}
                  <ComputerActivityBar />
                  {/* Nomi 桌面工具的授权卡片：对话窗口开着时确认请求只发到这里 */}
                  <DesktopConfirmDock />
                  <PendingDock
                    items={pending.items}
                    onWithdraw={pending.onWithdraw}
                    onRemove={pending.onRemove}
                  />
                  {/* 新会话：输入框上方的项目 · 分支，可以自由切换 */}
                  <NewChatContext />
                  <MessageInput
                    {...inputModeProps}
                    floating={resourcePreview.isOpen && resourcePreview.expanded}
                    compact={resourcePreview.isOpen && resourcePreview.expanded}
                    disabled={resourcePreview.sendMismatch || previewChat.busy}
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
                    draftStore={drafts.draftStore}
                    draftKey={drafts.draftKey}
                    // 只在编程助手标签里：Nomi 自己的 Skills / MCP 在「扩展」里管理
                    onPluginsClick={slashBackend !== 'nomi' ? panels.openPlugins : undefined}
                    onProvidersClick={panels.openProviders}
                    onSettingsClick={panels.onInputSettings}
                    onDesktopClick={panels.openDesktop}
                    onHubClick={panels.openHub}
                    onExtClick={panels.openExt}
                    onLocalClick={panels.openLocal}
                  />
                </footer>
              </div>

              {resourcePreview.panel}
              {centerOpen ? (
                <>
                  <div
                    className="center-changes-splitter"
                    data-testid="center-changes-splitter"
                    role="separator"
                    aria-orientation="vertical"
                    aria-valuenow={split.chatColumn.width}
                    aria-valuemin={CHAT_COL_W_MIN}
                    aria-valuemax={CHAT_COL_W_MAX}
                    onPointerDown={split.chatColumn.onPointerDown}
                    onDoubleClick={split.chatColumn.onDoubleClick}
                    title={t('ui.session-workspace.drag-to-resize-chat-and-diff-double-click')}
                  />
                  <SideColumn messages={rail.messages} cwd={rail.cwd} roots={rail.roots} />
                </>
              ) : null}
            </div>
            {!mainHidden && <SessionDetailsDock messages={rail.messages} cwd={rail.cwd} />}
            {/* 整页（素材库 / 任务 / Agent 看板）：替换对话区（对话区只隐藏不卸载），侧栏保持 */}
            {mainPages.pages}
            {filesRail.value && !mainHidden ? (
              <FilesRail rail={rail} split={split.filesRail} closing={filesRail.closing} />
            ) : null}
          </div>
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

function App() {
  const client = useOptionalAIClient();
  return (
    <ErrorBoundary>
      <AiChatContextProvider client={client}>
        <HarnessTabsProvider>
          <WorkspacePanesProvider>
            <AiChatContent />
          </WorkspacePanesProvider>
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
