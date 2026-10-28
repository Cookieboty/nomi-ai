import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import * as AISdkReact from '@nomi-ai/ai-sdk-client/react';
import { t } from '@nomi-ai/ui';
import { Button, ModalHostContext, type ModalHost } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AppEntries } from './components/AppEntries';
import { ChatBackgroundLayer } from './components/ChatBackground/ChatBackgroundLayer';
import { ChatHeader } from './components/ChatHeader';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { ConversationView } from './components/Conversation';
import { CliConversation } from './components/Conversation/CliConversation';
import { buildCliSlots } from './components/Conversation/cliSlots';
import { GeminiTrustAction } from './components/Conversation/GeminiTrustAction';
import type { ConvSlots } from './components/Conversation/Messages';
import { nomiSlots } from './components/Conversation/nomiSlots';
import { SessionControls, WorkspaceControl } from './components/EndpointControls';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ForkTargetMenu, type ForkPick } from './components/ForkMenu';
import {
  DesktopPanel,
  ExtensionsPanel,
  SettingsView,
  prefetchPanels,
} from './components/lazyPanels';
import { MessageInput } from './components/MessageInput';
import { OnboardingHost } from './components/Onboarding';
import { OPEN_MODELS_EVENT } from './components/Onboarding/client';
import { onboardingClient } from './components/Onboarding/client';
import { PluginPanel } from './components/PluginPanel';
import { ReleaseNotesHost } from './components/ReleaseNotesModal';
import {
  ChangesUiProvider,
  ChangesWorkbenchHost,
  CenterChangesHost,
  FilesRailToggle,
  SessionChangesPanel,
  useChangesUi,
} from './components/SessionWorkspace';
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
  type SettingsTab,
} from './components/SettingsView/sections';
import { Sidebar } from './components/Sidebar';
import { AppTitleBar } from './components/TitleBar';
import { AiChatContextProvider } from './contexts/AiChatContext';
import type { AiChatState } from './contexts/AiChatContext';
import {
  selectFirstMessageId,
  selectIpcClient,
  selectIsLoading,
  selectMessageCount,
  shallowArrayEqual,
  useAiChatActions,
  useAiChatSelector,
} from './contexts/aiChatStore';
import {
  HarnessTabsProvider,
  useHarnessLive,
  useHarnessTabsCore,
} from './contexts/HarnessTabsContext';
import { useChatMode } from './hooks/useChatMode';
import { useHarnessState } from './hooks/useHarnessState';
import { useNomiModelStatus } from './hooks/useNomiModelStatus';
import { useRestoreNomiOnMain } from './hooks/useRestoreNomiOnMain';
import { useSendQueue } from './hooks/useSendQueue';
import { useUserProfile } from './hooks/useUserProfile';
import { setProviderEndpoint } from './services/chatPrefs';
import { notifyConversationsChanged } from './services/conversationStore';
import { desktopClient } from './services/desktopClient';
import {
  FILES_RAIL_W_DEFAULT,
  FILES_RAIL_W_KEY,
  FILES_RAIL_W_MAX,
  FILES_RAIL_W_MIN,
  persistFilesRailOpen,
  readFilesRailOpen,
  readFilesRailWidth,
} from './services/filesRailPrefs';
import { forkCrossBackend, forkSameBackend } from './services/forkConversation';
import { harnessClient, type ContextBreakdown } from './services/harnessClient';
import { derivedSwitchTip } from './services/modelSwitchTip';
import { nomiModelLabel, useGatewayState, watchNomiModel } from './services/nomiModel';
import { providerClient } from './services/providerClient';
import { QUICK_PROMPT_TEXT, recommend } from './services/recommendations';
import type { ImageAttachment } from './services/screenClient';
import {
  RENAME_CHAT_EVENT,
  SEARCH_CHATS_EVENT,
  SHORTCUT_DEFS,
  formatCombo,
  isMac,
  matchShortcut,
  useShortcutBindings,
  type ShortcutId,
} from './services/shortcuts';
import { nomiScopeKey } from './slash/nomiScope';
import { reportedModel, withLiveContext } from './slash/tokens';
import { useSlashCommands } from './slash/useSlashCommands';
import type { ConversationBackend } from './types/chat';
import { isConversationBackend } from './types/chat';
import {
  CHAT_COL_W_DEFAULT,
  CHAT_COL_W_MAX,
  CHAT_COL_W_MIN,
  persistChatColumnWidth,
  readChatColumnWidth,
} from './utils/chatColumnWidth';
import { useCliImageSupport } from './utils/cliImageSupport';
import { cliTabPlaceholder } from './utils/cliTabPlaceholder';
import {
  fromHarnessMessage,
  nomiConvMessages,
  nomiLive,
  sameLive,
  settledNomiMessages,
} from './utils/convAdapters';
import { aggregateSessionChanges } from './utils/sessionChanges';
import { startSplitDrag } from './utils/splitDrag';
import './App.css';

const selectSettledNomi = (s: AiChatState) => settledNomiMessages(s.messages, s.isLoading);
const selectNomiLive = (s: AiChatState) => nomiLive(s.messages, s.isLoading);

/** The Nomi conversation: the only part that rerenders per streamed frame (its live turn). */
const NomiConversation: React.FC<Omit<React.ComponentProps<typeof ConversationView>, 'live'>> = (
  props,
) => {
  const live = useAiChatSelector(selectNomiLive, sameLive);
  // 换了 Nomi 的模型、还没发送：和最后一条助手消息的模型比（网关状态变化时重算）
  useGatewayState();
  const current = nomiModelLabel();
  const modelSwitchTip = useMemo(
    () => derivedSwitchTip(props.messages, current),
    [props.messages, current],
  );
  return <ConversationView {...props} live={live} modelSwitchTip={modelSwitchTip} />;
};

const AiChatContent: React.FC = () => {
  const [filesRailWidth, setFilesRailWidth] = useState(readFilesRailWidth);
  const [chatColumnWidth, setChatColumnWidth] = useState(readChatColumnWidth);
  const { workbench, previewOpen, composerFill } = useChangesUi();

  const onFilesRailSplitterDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = filesRailWidth;
    startSplitDrag({
      el: e.currentTarget,
      pointerId: e.pointerId,
      onMove: (ev) =>
        setFilesRailWidth(
          Math.min(FILES_RAIL_W_MAX, Math.max(FILES_RAIL_W_MIN, startW + (startX - ev.clientX))),
        ),
      onEnd: (cancelled) => {
        if (cancelled) {
          setFilesRailWidth(startW);
          return;
        }
        setFilesRailWidth((w) => {
          try {
            localStorage.setItem(FILES_RAIL_W_KEY, String(w));
          } catch {
            /* ignore */
          }
          return w;
        });
      },
    });
  };

  const onFilesRailSplitterDbl = () => {
    setFilesRailWidth(FILES_RAIL_W_DEFAULT);
    try {
      localStorage.setItem(FILES_RAIL_W_KEY, String(FILES_RAIL_W_DEFAULT));
    } catch {
      /* ignore */
    }
  };

  const onChatColSplitterDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = chatColumnWidth;
    startSplitDrag({
      el: e.currentTarget,
      pointerId: e.pointerId,
      onMove: (ev) =>
        setChatColumnWidth(
          Math.min(CHAT_COL_W_MAX, Math.max(CHAT_COL_W_MIN, startW + (ev.clientX - startX))),
        ),
      onEnd: (cancelled) => {
        if (cancelled) {
          setChatColumnWidth(startW);
          return;
        }
        setChatColumnWidth((w) => {
          persistChatColumnWidth(w);
          return w;
        });
      },
    });
  };

  const onChatColSplitterDbl = () => {
    setChatColumnWidth(CHAT_COL_W_DEFAULT);
    persistChatColumnWidth(CHAT_COL_W_DEFAULT);
  };

  // Slices, not the whole state: a streamed frame changes only the live tail, which
  // NomiConversation subscribes to; App and the rest of the tree stay put.
  const { actions, store: chatStore } = useAiChatActions();
  const isLoading = useAiChatSelector(selectIsLoading);
  const ipcClient = useAiChatSelector(selectIpcClient);
  const firstMessageId = useAiChatSelector(selectFirstMessageId);
  const messageCount = useAiChatSelector(selectMessageCount);
  const settledNomi = useAiChatSelector(selectSettledNomi, shallowArrayEqual);
  // 不订阅完整标签列表：后台标签的状态 / 未读广播不让整个 App 重渲染
  const tabs = useHarnessTabsCore();
  const { isDev, setMode } = useChatMode();
  // 精简模式（工作台）：不显示顶部对话标签条，顶栏只放当前会话的标题
  // ───── 统一会话视图的数据：Nomi 主对话与编程助手标签走同一个 ConversationView ─────
  const nomiMessages = useMemo(() => nomiConvMessages(settledNomi), [settledNomi]);
  const cliBackend = tabs.activeTab?.backend ?? 'claude';
  const cliConvMessages = useMemo(
    () => (tabs.isCliTab ? tabs.messages.map((m) => fromHarnessMessage(m, cliBackend)) : []),
    [tabs.isCliTab, tabs.messages, cliBackend],
  );
  // 右栏（改动 · 文件）默认收起、不常驻：顶栏开关 / 右栏 × 切换，记住上次的选择；
  // 有变更时顶栏开关带数字提示，点摘要卡「查看变更」也会展开
  const [railPref, setRailPref] = useState(readFilesRailOpen);
  // 上下文环 / `/context`：优先用 CLI 自己的会话记录（Claude：总量 + 分项都准，含重启后、压缩后被中断、
  // 在终端里直接用过 CLI 的情况）；没有时用一轮进行中实时上报的占用；都没有才按落盘消息估算。
  // 作为一条只带用量的助手消息接在消息末尾（见 withLiveContext）
  const activeTabId = tabs.activeTab?.id;
  const activeRunning = tabs.activeTab?.status === 'running';
  const streamContext = useHarnessLive((l) => (activeTabId ? l[activeTabId]?.context : undefined));
  const [cliRecordContext, setCliRecordContext] = useState<{
    tabId: string;
    tokens: number;
    model?: string;
    breakdown?: ContextBreakdown;
  } | null>(null);
  useEffect(() => {
    if (!tabs.isCliTab || !activeTabId) return;
    let stale = false;
    harnessClient
      .tabContext(activeTabId)
      .then((r) => {
        if (!stale)
          setCliRecordContext(
            r
              ? {
                  tabId: activeTabId,
                  tokens: r.contextTokens,
                  model: r.model,
                  breakdown: r.breakdown,
                }
              : null,
          );
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
    // 运行中每次实时上报（≈ 每次模型请求）重读一次；主进程按文件大小 + 修改时间缓存
  }, [tabs.isCliTab, activeTabId, activeRunning, cliConvMessages.length, streamContext?.tokens]);
  const recordContext =
    cliRecordContext && cliRecordContext.tabId === activeTabId ? cliRecordContext : undefined;
  const liveContext = useMemo(
    () => (recordContext ? { ...recordContext, window: streamContext?.window } : streamContext),
    [recordContext, streamContext],
  );
  const cliContextMessages = useMemo(
    () => withLiveContext(cliConvMessages, liveContext),
    [cliConvMessages, liveContext],
  );
  const sessionChangeCount = useMemo(
    () => aggregateSessionChanges(cliConvMessages).length,
    [cliConvMessages],
  );
  const railTabId = isDev && tabs.isCliTab ? (tabs.activeTab?.id ?? null) : null;
  // 中栏查看区：本会话 Diff（workbench）或右栏的文件预览
  const centerOpen = !!railTabId && (!!workbench || previewOpen);
  const railOpen = !!railTabId && railPref;
  const setRailOpen = useCallback((open: boolean) => {
    setRailPref(open);
    persistFilesRailOpen(open);
  }, []);
  const toggleRail = useCallback(() => setRailOpen(!railOpen), [railOpen, setRailOpen]);
  const closeRail = useCallback(() => setRailOpen(false), [setRailOpen]);
  // 摘要卡「查看变更」要在右栏定位文件：收起着也展开（渲染期比对，不在 effect 里 setState）
  const [prevWorkbench, setPrevWorkbench] = useState(workbench);
  if (prevWorkbench !== workbench) {
    setPrevWorkbench(workbench);
    if (workbench && railTabId && !railPref) setRailOpen(true);
  }
  // 编程助手标签的错误卡片：Gemini 不信任工作目录时提供「信任此文件夹」
  const activeCliTabId = tabs.isCliTab ? (tabs.activeTab?.id ?? null) : null;
  const activeCwd = tabs.isCliTab ? (tabs.activeTab?.cwd ?? null) : null;
  const cliSlots = useMemo<ConvSlots | undefined>(
    () =>
      activeCliTabId
        ? buildCliSlots({
            cwd: activeCwd,
            errorActions: (m, { retry }) =>
              m.geminiTrust ? (
                <GeminiTrustAction key={m.id} tabId={activeCliTabId} message={m} retry={retry} />
              ) : null,
          })
        : undefined,
    [activeCliTabId, activeCwd],
  );
  // 不论从哪个入口回到主标签（顶栏 / 快捷键 / 侧栏 / 分叉后），都把当前会话恢复成 Nomi 会话
  useRestoreNomiOnMain(
    tabs.activeTabId,
    () => ipcClient.conversationStore?.(),
    () => actions.loadChatHistory(),
  );
  const nomiQueue = useSendQueue(
    isLoading,
    // 入队时冻结的意图：知识库问答排的队，出队后仍走带引用的问答
    (text, opts) => (opts?.kb ? actions.askKnowledge(text) : actions.sendStreamMessage(text)),
    firstMessageId,
  );
  /** 重新生成 / 重试：找到这条助手消息之前的用户消息，从那里重发 */
  const precedingUser = <T extends { id: string; role: string }>(
    list: readonly T[],
    id: string,
  ) => {
    const i = list.findIndex((m) => m.id === id);
    for (let k = i - 1; k >= 0; k--) if (list[k]!.role === 'user') return list[k]!;
    return undefined;
  };
  const cliHasLive = useHarnessLive((l) => !!(activeCliTabId && l[activeCliTabId]));
  const [forkCross, setForkCross] = useState<{
    id: string;
    backend: ConversationBackend;
    mode: 'same' | 'cross';
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // 切到普通模式时关掉已打开的「分叉到其他端」选择框（渲染期根据 isDev 变化重置，避免 effect 内 setState 触发级联渲染）
  const [prevIsDev, setPrevIsDev] = useState(isDev);
  if (prevIsDev !== isDev) {
    setPrevIsDev(isDev);
    if (!isDev && forkCross?.mode === 'cross') setForkCross(null);
  }
  useEffect(() => {
    if (!toast) return;
    const tid = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(tid);
  }, [toast]);

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
  // mascot holds a thinking pose while a reply is being generated (semantic event, §10.5)
  useEffect(() => {
    if (!isLoading) return;
    onboardingClient.mascot({ type: 'reply', phase: 'waiting' });
    return () => onboardingClient.mascot({ type: 'reply', phase: 'settled' });
  }, [isLoading]);
  const [showDesktop, setShowDesktop] = useState(false);
  // 托盘「桌面能力…」→ 打开桌面能力面板
  useEffect(() => desktopClient.onOpenPanel(() => setShowDesktop(true)), []);
  const [showExt, setShowExt] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 720);
  // 窗口变窄时自动收起侧栏，避免挤压对话区
  useEffect(() => {
    const onResize = () => window.innerWidth < 720 && setSidebarCollapsed(true);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 切到普通模式时若正停在 CLI 标签，回到主对话（后台标签继续跑）
  useEffect(() => {
    if (isDev) return;
    if (tabs.isCliTab) void tabs.activate('main');
  }, [isDev, tabs.isCliTab, tabs]);

  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [settingsLink, setSettingsLink] = useState<{ tab?: SettingsTab } | undefined>();
  const openSettings = useCallback((sec: SettingsSection = 'general', tab?: SettingsTab) => {
    setSettingsLink(tab ? { tab } : undefined);
    setShowExt(false);
    setShowDesktop(false);
    setSettings(sec);
  }, []);
  // 托盘「模型设置…」→ 设置 →「模型与供应商」
  useEffect(() => providerClient.onOpenPanel(() => openSettings('models')), [openSettings]);
  // 新手引导里「打开完整模型设置」/「去接上模型」
  useEffect(() => {
    const open = () => openSettings('models');
    window.addEventListener(OPEN_MODELS_EVENT, open);
    return () => window.removeEventListener(OPEN_MODELS_EVENT, open);
  }, [openSettings]);
  useEffect(() => watchNomiModel(), []);
  // 看板娘「TTS 语音配置」/ 语音错误「去设置」→ 设置 → 通用 → 语音
  useEffect(
    () => desktopClient.onOpenVoiceSettings(() => openSettings('general', 'voice')),
    [openSettings],
  );
  // 看板娘「日程」→ 设置 → 知识与记忆 → 日程
  useEffect(
    () => desktopClient.onOpenSchedule(() => openSettings('knowledge', 'schedule')),
    [openSettings],
  );
  // ---- 斜杠命令：输入 / 弹出命令面板，命令结果以系统卡片显示在会话流里 ----
  const harness = useHarnessState();
  const slashTab = isDev && tabs.isCliTab ? tabs.activeTab : null;
  const slashBackend: ConversationBackend = !isDev
    ? 'nomi'
    : (slashTab?.backend ?? harness?.backend ?? 'nomi');
  const slashCwd = slashBackend === 'nomi' ? '' : slashTab ? slashTab.cwd : (harness?.cwd ?? '');
  /** Nomi 主对话当前会话的标识（不论眼下显示的是不是它） */
  const nomiScope = nomiScopeKey(ipcClient.conversationStore?.(), firstMessageId);
  const slashScope = slashTab ? slashTab.id : nomiScope;
  const [showPlugins, setShowPlugins] = useState(false);
  const slash = useSlashCommands({
    backend: slashBackend,
    cwd: slashCwd,
    scopeKey: slashScope,
    messages: slashTab ? cliContextMessages : nomiMessages,
    session:
      slashBackend === 'nomi'
        ? null
        : slashTab
          ? {
              id: slashTab.cliSessionId,
              running: slashTab.status === 'running' || slashTab.status === 'queued',
            }
          : { id: harness?.cliSessionId ?? null, running: !!harness?.busy },
    tabId: slashTab?.id ?? null,
    send: (text) => {
      if (slashTab) void tabs.send(text);
      else if (isLoading) nomiQueue.enqueue(text);
      else void actions.sendStreamMessage(text);
    },
    // 异步命令的结果回到「发起命令的会话」，与现在显示哪个标签无关
    sendTo: async (target, text) => {
      if (target.tabId) {
        // CLI 标签：目标标签已关闭 / 后端或目录被改过（重置）→ false，什么都不发
        return tabs.sendToTab(target.tabId, text, { backend: target.backend, cwd: target.cwd });
      }
      // Nomi 主对话：只有它仍是当前这个会话才发（新建 / 切换过会话则丢弃）
      if (nomiScope !== target.scopeKey) return false;
      if (isLoading) nomiQueue.enqueue(text);
      else void actions.sendStreamMessage(text);
      return true;
    },
    tabExists: tabs.hasTab,
    newSession: () => {
      if (slashTab) void tabs.create(slashTab.backend, slashTab.cwd);
      else void actions.newConversation();
    },
    onOpenPlugins: () => setShowPlugins(true),
    onOpenProviders: () => openSettings('models'),
    onOpenSettings: () => {
      if (slashBackend !== 'nomi') setProviderEndpoint(slashBackend);
      openSettings('coding');
    },
  });
  // ---- 快捷键（可在设置 → 快捷键 改绑）+ ⌘/Ctrl+K 命令面板 ----
  const bindings = useShortcutBindings();
  const [palette, setPalette] = useState(false);
  const focusInput = useCallback(() => {
    setSettings(null);
    setTimeout(
      () => document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')?.focus(),
      0,
    );
  }, []);
  const newChat = useCallback(() => {
    setSettings(null);
    actions.newConversation();
    focusInput();
  }, [actions, focusInput]);

  const runForkSame = useCallback(
    async (id: string, pick: ForkPick = {}) => {
      const store = ipcClient.conversationStore?.();
      if (!store) return;
      setForkCross(null);
      try {
        const r = await forkSameBackend(store, id, { turns: pick.turns });
        if (r.backend !== 'nomi') setMode('dev');
        if (r.tabId) await tabs.activate(r.tabId);
        else {
          if (tabs.available) await tabs.activate('main');
          await actions.loadChatHistory();
        }
        // 激活 / 重载后再广播一次：侧栏列表只在消息数变化时才会自刷新
        notifyConversationsChanged();
        setToast(t('ui.cli-monitor.forked-as', r.title));
      } catch (e) {
        setToast(e instanceof Error ? e.message : String(e));
      }
    },
    [ipcClient, setMode, tabs, actions],
  );

  const runForkCross = useCallback(
    async (id: string, target: ConversationBackend, pick: ForkPick) => {
      const store = ipcClient.conversationStore?.();
      if (!store) return;
      setForkCross(null);
      try {
        const r = await forkCrossBackend(store, id, target, pick);
        if (r.backend !== 'nomi') setMode('dev');
        if (r.tabId) await tabs.activate(r.tabId);
        else {
          if (tabs.available) await tabs.activate('main');
          await actions.loadChatHistory();
        }
        notifyConversationsChanged();
        setToast(t('ui.cli-monitor.forked-to', r.title));
      } catch (e) {
        setToast(e instanceof Error ? e.message : String(e));
      }
    },
    [ipcClient, setMode, tabs, actions],
  );

  const onForkRequest = useCallback(
    (id: string, mode: 'same' | 'cross') => {
      const store = ipcClient.conversationStore?.();
      const meta = store?.get(id);
      if (!meta) return;
      // 都先选带入几轮；普通模式不允许分叉到其他端
      if (mode === 'same' || isDev) setForkCross({ id, backend: meta.backend, mode });
    },
    [ipcClient, isDev],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (!(isMac() ? e.metaKey : e.ctrlKey) || !e.shiftKey || e.altKey || e.code !== 'KeyF')
        return;
      const id = ipcClient.currentConversationId?.();
      if (!id) return;
      e.preventDefault();
      void runForkSame(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ipcClient, runForkSame]);

  const shortcutActions = useMemo<Partial<Record<ShortcutId, () => void>>>(
    () => ({
      palette: () => setPalette((v) => !v),
      newChat,
      searchChats: () => {
        setSidebarCollapsed(false);
        window.dispatchEvent(new Event(SEARCH_CHATS_EVENT));
      },
      focusInput,
      settings: () => setSettings((s) => (s ? null : 'general')),
      sidebar: () => setSidebarCollapsed((v) => !v),
      hub: () => openSettings('knowledge'),
      ext: () => setShowExt((v) => !v),
      local: () => openSettings('models', 'local'),
      newTab: () => {
        if (!isDev) return;
        // 按当前会话的端和目录直接新开；Nomi 会话则新开对话（其它端从侧栏的新建菜单选）
        const cur = tabs.activeTab;
        if (cur && cur.backend !== 'nomi')
          void tabs.create(cur.backend, cur.cwd).catch(() => undefined);
        else newChat();
      },
      closeTab: () => {
        if (!isDev) return;
        if (tabs.activeTab) void tabs.close(tabs.activeTab.id);
      },
      nextTab: () => {
        if (!isDev) return;
        tabs.cycle(1);
      },
      prevTab: () => {
        if (!isDev) return;
        tabs.cycle(-1);
      },
      renameTab: () => {
        // 在侧栏的会话列表里给当前会话改名
        if (!isDev) return;
        window.dispatchEvent(new Event(RENAME_CHAT_EVENT));
      },
    }),
    [newChat, focusInput, tabs, isDev, openSettings],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      // 正在设置页里录制新快捷键时不触发
      if ((e.target as HTMLElement | null)?.closest?.('[data-shortcut-recording="true"]')) return;
      // 标签：Ctrl+Tab / Ctrl+Shift+Tab（各平台都用 Ctrl）与 Mod+1…9
      if (isDev && tabs.available && e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        tabs.cycle(e.shiftKey ? -1 : 1);
        return;
      }
      if (
        isDev &&
        tabs.available &&
        (isMac() ? e.metaKey : e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        /^Digit[1-9]$/.test(e.code)
      ) {
        e.preventDefault();
        tabs.selectIndex(Number(e.code.slice(5)) - 1);
        return;
      }
      for (const [id, run] of Object.entries(shortcutActions) as Array<[ShortcutId, () => void]>) {
        if (!matchShortcut(e, bindings[id])) continue;
        // 弹窗打开时只响应命令面板 / 面板开关，不在弹窗背后新建对话或抢焦点
        const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
        if (modal && (id === 'newChat' || id === 'focusInput')) return;
        if (modal && id === 'palette' && !modal.closest('[data-testid="command-palette"]')) return;
        e.preventDefault();
        run();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bindings, shortcutActions, tabs, isDev]);
  // 快速视图：右侧抽屉 + 「在设置中打开」
  const drawerHost = useMemo(() => {
    const mk = (sec: SettingsSection, tab?: SettingsTab): ModalHost => ({
      mode: 'drawer',
      onOpenSettings: () => openSettings(sec, tab),
    });
    return {
      ext: mk('ext'),
      desktop: mk('privacy', 'desktop'),
    };
  }, [openSettings]);

  const handleNewChat = useCallback(() => actions.newConversation(), [actions]);
  // 欢迎屏：Nomi 对话还没有模型时，快捷问题换成「添加模型」/「选择模型」，免得一点就报错
  const modelStatus = useNomiModelStatus();
  // 欢迎页的示例问题按新手引导里选的职业与兴趣推荐
  const quickPrompts = recommend(useUserProfile()).prompts;

  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      ...SHORTCUT_DEFS.filter((d) => d.id !== 'palette' && shortcutActions[d.id]).map((d) => ({
        id: d.id,
        label: d.label,
        group: 'ui.foundation.action',
        hint: formatCombo(bindings[d.id]),
        run: shortcutActions[d.id]!,
      })),
      ...SETTINGS_SECTIONS.map((sec) => ({
        id: `settings-${sec.id}`,
        label: sec.label,
        group: 'ui.foundation.settings',
        run: () => openSettings(sec.id),
      })),
    ],
    [bindings, shortcutActions, openSettings],
  );
  // ───── stable props for the memoized composer / conversation / panels ─────
  const onNomiRetry = useCallback(
    (id: string) => {
      const u = precedingUser(chatStore.get().messages, id);
      if (u) void actions.resendFrom(u.id);
    },
    [chatStore, actions],
  );
  const onNomiEdit = useCallback(
    (id: string, text: string) => void actions.resendFrom(id, text),
    [actions],
  );
  const cliActive = isDev && tabs.isCliTab ? tabs.activeTab : null;
  // 能不能附图看这个会话当前用的模型（dsh 例外：命令行没有图片输入）
  const cliImages = useCliImageSupport(cliActive);
  const tabSend = tabs.send;
  const tabCancel = tabs.cancel;
  // 只依赖用到的原始字段：当前标签的 updatedAt / unread 等变化不重建 props，MessageInput 的 memo 才守得住
  const cliBusy = !!cliActive && (cliActive.status === 'running' || cliActive.status === 'queued');
  const cliPlaceholder = cliActive ? cliTabPlaceholder(cliActive) : undefined;
  const hasCliActive = !!cliActive;
  const inputModeProps = useMemo(
    () =>
      hasCliActive
        ? {
            onSend: (text: string, images?: ImageAttachment[]) => {
              const imgs = images?.map((im) => ({
                mime: im.mime,
                data: im.data,
                width: im.width,
                height: im.height,
                thumb: im.thumb,
                source: im.source,
              }));
              void tabSend(text, imgs);
            },
            busyOverride: cliBusy,
            imageCapability: cliImages.capability,
            imageUnsupportedReason: cliImages.reason,
            placeholder: cliPlaceholder,
            queue: {
              onQueue: (text: string) => void tabSend(text),
              onStop: () => void tabCancel(),
            },
          }
        : { queue: { onQueue: nomiQueue.enqueue } },
    [hasCliActive, cliBusy, cliPlaceholder, cliImages, tabSend, tabCancel, nomiQueue.enqueue],
  );
  const openPlugins = useCallback(() => setShowPlugins(true), []);
  const closePlugins = useCallback(() => setShowPlugins(false), []);
  const openProviders = useCallback(() => openSettings('models'), [openSettings]);
  const onInputSettings = useCallback(
    (sec?: SettingsSection, endpoint?: unknown) => {
      if (isConversationBackend(endpoint)) setProviderEndpoint(endpoint);
      openSettings(sec);
    },
    [openSettings],
  );
  const openDesktop = useCallback(() => setShowDesktop(true), []);
  const closeDesktop = useCallback(() => setShowDesktop(false), []);
  // 知识 · 记忆 · 日程、截图提问、本机模型都只在设置里有一个入口
  const openHub = useCallback(() => openSettings('knowledge'), [openSettings]);
  const openExt = useCallback(() => setShowExt(true), []);
  const closeExt = useCallback(() => setShowExt(false), []);
  const openLocal = useCallback(() => openSettings('models', 'local'), [openSettings]);
  const closeSettings = useCallback(() => setSettings(null), []);
  // 侧栏是 memo 组件：回调与 footer 都要稳定，否则 App 每次渲染都连带重渲染整个会话列表
  const toggleSidebar = useCallback(() => setSidebarCollapsed((v) => !v), []);
  const openSidebarSettings = useCallback(
    (sec: SettingsSection, tab?: SettingsTab) => openSettings(sec, tab),
    [openSettings],
  );
  const openGeneralSettings = useCallback(() => openSettings(), [openSettings]);
  const sidebarFooter = useMemo(
    () => (
      <AppEntries
        collapsed={sidebarCollapsed}
        onHub={openHub}
        onExt={openExt}
        onSettings={openGeneralSettings}
      />
    ),
    [sidebarCollapsed, openHub, openExt, openGeneralSettings],
  );

  const paletteEl = (
    <CommandPalette open={palette} onClose={() => setPalette(false)} commands={paletteCommands} />
  );

  return (
    <div className="ai-chat-app">
      <ChatBackgroundLayer />
      <AppTitleBar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
      {/* 会话树保活：打开设置时只隐藏（display:none）不卸载，避免关闭时整树冷重挂载导致卡顿、
          草稿/滚动位置丢失与 IPC 订阅重建 */}
      <div className={settings ? 'chat-keepalive-hidden' : 'chat-keepalive'}>
        {/* 侧边栏 */}
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={toggleSidebar}
          onNewChat={handleNewChat}
          onForkRequest={onForkRequest}
          onNotice={setToast}
          onOpenSettings={openSidebarSettings}
          footer={sidebarFooter}
        />

        {/* 主内容：无查看区时对话全宽；有本会话 Diff 或右栏文件预览时 chat-column | 中栏 横排全高 */}
        <div
          className={centerOpen ? 'main-content main-content--with-changes' : 'main-content'}
          data-with-changes={centerOpen ? 'true' : undefined}
        >
          <div
            className="chat-column"
            data-testid="chat-column"
            style={{
              ...(centerOpen
                ? {
                    width: chatColumnWidth,
                    // 窗口窄时最小宽度随窗口收缩（App.css 的 --cd-chat-col-min），宽屏仍是 CHAT_COL_W_MIN
                    minWidth: 'var(--cd-chat-col-min)',
                    maxWidth: CHAT_COL_W_MAX,
                    // 窗口不够时先压对话列（到最小宽度），不把中栏挤没
                    flexShrink: 1,
                  }
                : {}),
            }}
          >
            <ChatHeader
              trailing={
                <>
                  {/* 工作目录 + 这个目录的改动 / 文件：都是当前会话所在的工作区 */}
                  <WorkspaceControl />
                  {railTabId ? (
                    <FilesRailToggle
                      open={railOpen}
                      count={sessionChangeCount}
                      onToggle={toggleRail}
                    />
                  ) : null}
                </>
              }
            />
            {/* 待带入的新会话前文属于当前对话状态，放在对话区顶部，避免和输入工具混在一起。 */}
            <div className="session-bar chat-session-bar">
              <SessionControls />
            </div>
            {/* 对话区域 */}
            <main className="chat-container">
              {isDev && tabs.isCliTab ? (
                <>
                  {tabs.messages.length === 0 &&
                  !cliHasLive &&
                  slash.cards.length === 0 &&
                  tabs.activeTab!.status === 'idle' ? (
                    <div className="welcome-screen" data-testid="cli-tab-empty">
                      <div className="welcome-content">
                        <h2 className="welcome-title">
                          {t('ui.mascot-theme.new-session', tabs.activeTab!.title)}
                        </h2>
                        <p className="welcome-subtitle">
                          {t('ui.mascot-theme.messages-go-to-the-coding-agent-on-this')}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <CliConversation
                      scopeId={tabs.activeTab!.id}
                      messages={cliConvMessages}
                      phase={
                        tabs.activeTab!.status === 'running'
                          ? 'running'
                          : tabs.activeTab!.status === 'queued'
                            ? 'queued'
                            : 'idle'
                      }
                      queued={tabs.queues[tabs.activeTab!.id]}
                      onRemoveQueued={tabs.removeQueued}
                      slots={cliSlots}
                      cards={slash.cards}
                      onDismissCard={slash.dismissCard}
                      dormant={tabs.activeTab!.dormant}
                      backgroundAgents={tabs.activeTab!.backgroundAgents}
                      backgroundCount={tabs.activeTab!.background}
                    />
                  )}
                </>
              ) : messageCount === 0 && slash.cards.length === 0 ? (
                <div className="welcome-screen" data-testid="welcome-screen">
                  <div className="welcome-content">
                    <h2 className="welcome-title">
                      {t('ui.foundation.what-would-you-like-to-do-today')}
                    </h2>
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
                        <Button
                          variant="primary"
                          onClick={() => openSettings('models')}
                          data-testid="welcome-add-model"
                        >
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
              ) : (
                <NomiConversation
                  scopeId={`nomi:${firstMessageId ?? 'new'}`}
                  messages={nomiMessages}
                  phase={isLoading ? 'running' : 'idle'}
                  queued={nomiQueue.queue}
                  onRemoveQueued={nomiQueue.remove}
                  onRetry={onNomiRetry}
                  onEdit={onNomiEdit}
                  slots={nomiSlots}
                  cards={slash.cards}
                  onDismissCard={slash.dismissCard}
                />
              )}
            </main>

            {/* 输入区域 */}
            <footer className="input-container">
              <MessageInput
                {...inputModeProps}
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
                onPluginsClick={openPlugins}
                onProvidersClick={openProviders}
                onSettingsClick={onInputSettings}
                onDesktopClick={openDesktop}
                onHubClick={openHub}
                onExtClick={openExt}
                onLocalClick={openLocal}
              />
            </footer>
          </div>

          {centerOpen && tabs.activeTab ? (
            <>
              <div
                className="center-changes-splitter"
                data-testid="center-changes-splitter"
                role="separator"
                aria-orientation="vertical"
                aria-valuenow={chatColumnWidth}
                aria-valuemin={CHAT_COL_W_MIN}
                aria-valuemax={CHAT_COL_W_MAX}
                onPointerDown={onChatColSplitterDown}
                onDoubleClick={onChatColSplitterDbl}
                title={t('ui.session-workspace.drag-to-resize-chat-and-diff-double-click')}
              />
              <CenterChangesHost messages={cliConvMessages} cwd={tabs.activeTab.cwd} />
            </>
          ) : null}
        </div>

        {railOpen && tabs.activeTab ? (
          <>
            <div
              className="files-rail-splitter"
              data-testid="files-rail-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={filesRailWidth}
              aria-valuemin={FILES_RAIL_W_MIN}
              aria-valuemax={FILES_RAIL_W_MAX}
              onPointerDown={onFilesRailSplitterDown}
              onDoubleClick={onFilesRailSplitterDbl}
              title={t('ui.session-workspace.drag-to-resize-chat-vs-workspace-double-click')}
            />
            <aside
              className="files-rail"
              data-testid="files-rail"
              style={{
                width: filesRailWidth,
                minWidth: 'var(--cd-files-rail-min)',
                maxWidth: FILES_RAIL_W_MAX,
                flexShrink: 1,
              }}
            >
              <SessionChangesPanel
                rail
                messages={cliConvMessages}
                cwd={tabs.activeTab.cwd}
                busy={tabs.activeTab.status === 'running' || tabs.activeTab.status === 'queued'}
                onClose={closeRail}
              />
              <ChangesWorkbenchHost messages={cliConvMessages} cwd={tabs.activeTab.cwd} />
            </aside>
          </>
        ) : null}
      </div>

      {/* 设置为覆盖层：会话树保持挂载，仅被此层盖住；关闭即瞬时回到原会话 */}
      {settings && (
        <div className="settings-overlay">
          <SettingsView
            section={settings}
            deepLink={settingsLink}
            onSection={setSettings}
            onClose={closeSettings}
            collapsed={sidebarCollapsed}
          />
        </div>
      )}

      {/* 模型配置保持为弹窗；日常功能为右侧抽屉（快速视图） */}
      {paletteEl}
      <PluginPanel
        isVisible={showPlugins}
        onClose={closePlugins}
        backend={slashBackend}
        cwd={slashCwd}
        entries={slash.discovered}
        onRefresh={slash.bridge.refresh}
        onManageNomi={() => {
          setShowPlugins(false);
          setShowExt(true);
        }}
      />
      <ModalHostContext.Provider value={drawerHost.desktop}>
        <DesktopPanel isVisible={showDesktop} onClose={closeDesktop} />
      </ModalHostContext.Provider>
      <ModalHostContext.Provider value={drawerHost.ext}>
        <ExtensionsPanel isVisible={showExt} onClose={closeExt} />
      </ModalHostContext.Provider>
      <ForkTargetMenu
        open={!!forkCross}
        mode={forkCross?.mode}
        current={forkCross?.backend ?? 'nomi'}
        onClose={() => setForkCross(null)}
        onPick={(b, pick) => {
          if (!forkCross) return;
          if (forkCross.mode === 'same') void runForkSame(forkCross.id, pick);
          else void runForkCross(forkCross.id, b, pick);
        }}
      />
      {toast && (
        <div
          role="status"
          data-testid="fork-toast"
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 120,
            padding: 'var(--cd-space-2) var(--cd-space-3)',
            borderRadius: 'var(--cd-radius-md)',
            background: 'var(--cd-color-surface-raised)',
            border: '1px solid var(--cd-color-border)',
            boxShadow: 'var(--cd-shadow-popover)',
            fontSize: 'var(--cd-font-size-sm)',
          }}
        >
          {toast}
        </div>
      )}
    </div>
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
          <ChangesUiProvider>
            <AiChatContent />
          </ChangesUiProvider>
        </HarnessTabsProvider>
        {/* 首次启动引导（未完成时覆盖在对话窗口上；设置 → 通用 可重新打开） */}
        <OnboardingHost />
        <ReleaseNotesHost />
      </AiChatContextProvider>
    </ErrorBoundary>
  );
}

export default App;
