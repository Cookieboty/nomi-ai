import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import * as AISdkReact from '@nomi-ai/ai-sdk-client/react';
import { t } from '@nomi-ai/ui';
import { ModalHostContext, type ModalHost } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AppEntries } from './components/AppEntries';
import { ChatBackgroundLayer } from './components/ChatBackground/ChatBackgroundLayer';
import { ChatHeader } from './components/ChatHeader';
import { ChatTabs, cliTabPlaceholder } from './components/ChatTabs';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { ConversationView } from './components/Conversation';
import { buildCliSlots } from './components/Conversation/cliSlots';
import { GeminiTrustAction } from './components/Conversation/GeminiTrustAction';
import type { ConvSlots } from './components/Conversation/Messages';
import { nomiSlots } from './components/Conversation/nomiSlots';
import { SessionControls } from './components/EndpointControls';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ForkTargetMenu } from './components/ForkMenu';
import type { HubTab } from './components/HubPanel';
import {
  DesktopPanel,
  ExtensionsPanel,
  HubPanel,
  LocalPanel,
  ScreenPanel,
  SettingsView,
  prefetchPanels,
} from './components/lazyPanels';
import { MessageInput } from './components/MessageInput';
import { OnboardingHost } from './components/Onboarding';
import { onboardingClient } from './components/Onboarding/client';
import { PluginPanel } from './components/PluginPanel';
import {
  ChangesUiProvider,
  ChangesWorkbenchHost,
  CenterChangesHost,
  FilesRailToggle,
  SessionChangesPanel,
  useChangesUi,
} from './components/SessionWorkspace';
import {
  LOCAL_MANAGE_TABS,
  SETTINGS_SECTIONS,
  type SettingsSection,
  type SettingsTab,
} from './components/SettingsView/sections';
import { Sidebar } from './components/Sidebar';
import { AppTitleBar, hasAppTitleBar } from './components/TitleBar';
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
import { HarnessTabsProvider, useHarnessTabs } from './contexts/HarnessTabsContext';
import { useChatMode } from './hooks/useChatMode';
import { useHarnessState } from './hooks/useHarnessState';
import { useRestoreNomiOnMain } from './hooks/useRestoreNomiOnMain';
import { useSendQueue } from './hooks/useSendQueue';
import { setProviderEndpoint } from './services/chatPrefs';
import { notifyConversationsChanged } from './services/conversationStore';
import { desktopClient } from './services/desktopClient';
import { forkCrossBackend, forkSameBackend } from './services/forkConversation';
import { harnessClient, type ContextBreakdown } from './services/harnessClient';
import { watchNomiModel } from './services/nomiModel';
import { providerClient } from './services/providerClient';
import { screenClient, type ImageAttachment, type ScreenState } from './services/screenClient';
import {
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
import { cliImageSupport } from './utils/cliImageSupport';
import {
  fromHarnessMessage,
  nomiConvMessages,
  nomiLive,
  sameLive,
  settledNomiMessages,
  tabLiveToConv,
} from './utils/convAdapters';
import { aggregateSessionChanges } from './utils/sessionChanges';
import './App.css';

const selectSettledNomi = (s: AiChatState) => settledNomiMessages(s.messages, s.isLoading);
const selectNomiLive = (s: AiChatState) => nomiLive(s.messages, s.isLoading);
const LOCAL_TABS = [...LOCAL_MANAGE_TABS];

/** The Nomi conversation: the only part that rerenders per streamed frame (its live turn). */
const NomiConversation: React.FC<Omit<React.ComponentProps<typeof ConversationView>, 'live'>> = (
  props,
) => {
  const live = useAiChatSelector(selectNomiLive, sameLive);
  return <ConversationView {...props} live={live} />;
};

const FILES_RAIL_W_KEY = 'nomi.filesRailWidth';
const FILES_RAIL_W_DEFAULT = 260;
const FILES_RAIL_W_MIN = 200;
const FILES_RAIL_W_MAX = 420;

const FILES_RAIL_OPEN_KEY = 'nomi.filesRailOpen';

/** 右栏开关：默认收起，只有用户展开过才记住为展开 */
function readFilesRailOpen(): boolean {
  try {
    return localStorage.getItem(FILES_RAIL_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function persistFilesRailOpen(open: boolean): void {
  try {
    localStorage.setItem(FILES_RAIL_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function readFilesRailWidth(): number {
  try {
    const n = Number(localStorage.getItem(FILES_RAIL_W_KEY));
    if (Number.isFinite(n)) {
      return Math.min(FILES_RAIL_W_MAX, Math.max(FILES_RAIL_W_MIN, Math.round(n)));
    }
  } catch {
    /* ignore */
  }
  return FILES_RAIL_W_DEFAULT;
}

const AiChatContent: React.FC = () => {
  const [filesRailWidth, setFilesRailWidth] = useState(readFilesRailWidth);
  const filesRailDrag = useRef<{ startX: number; startW: number } | null>(null);
  const [chatColumnWidth, setChatColumnWidth] = useState(readChatColumnWidth);
  const chatColDrag = useRef<{ startX: number; startW: number } | null>(null);
  const { workbench, previewOpen, composerFill } = useChangesUi();

  const onFilesRailSplitterDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    filesRailDrag.current = { startX: e.clientX, startW: filesRailWidth };
    el.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const d = filesRailDrag.current;
      if (!d) return;
      const next = Math.min(
        FILES_RAIL_W_MAX,
        Math.max(FILES_RAIL_W_MIN, d.startW + (d.startX - ev.clientX)),
      );
      setFilesRailWidth(next);
    };
    const onUp = (ev: PointerEvent) => {
      filesRailDrag.current = null;
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setFilesRailWidth((w) => {
        try {
          localStorage.setItem(FILES_RAIL_W_KEY, String(w));
        } catch {
          /* ignore */
        }
        return w;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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
    const el = e.currentTarget;
    chatColDrag.current = { startX: e.clientX, startW: chatColumnWidth };
    el.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const d = chatColDrag.current;
      if (!d) return;
      const next = Math.min(
        CHAT_COL_W_MAX,
        Math.max(CHAT_COL_W_MIN, d.startW + (ev.clientX - d.startX)),
      );
      setChatColumnWidth(next);
    };
    const onUp = (ev: PointerEvent) => {
      chatColDrag.current = null;
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setChatColumnWidth((w) => {
        persistChatColumnWidth(w);
        return w;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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
  const tabs = useHarnessTabs();
  const { isDev, setMode } = useChatMode();
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
  const streamContext = activeTabId ? tabs.live[activeTabId]?.context : undefined;
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
    tabs.state?.activeTabId,
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
  const [forkCross, setForkCross] = useState<{
    id: string;
    backend: ConversationBackend;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // 切到普通模式时关掉已打开的「分叉到其他端」选择框（渲染期根据 isDev 变化重置，避免 effect 内 setState 触发级联渲染）
  const [prevIsDev, setPrevIsDev] = useState(isDev);
  if (prevIsDev !== isDev) {
    setPrevIsDev(isDev);
    if (!isDev && forkCross !== null) setForkCross(null);
  }
  useEffect(() => {
    if (!toast) return;
    const tid = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(tid);
  }, [toast]);
  const [tabRename, setTabRename] = useState(0);
  const [tabNew, setTabNew] = useState(0);

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
  // mascot holds a thinking pose while a reply is being generated
  useEffect(() => {
    if (!isLoading) return;
    onboardingClient.mascot({ type: 'motion', name: 'think-on' });
    return () => onboardingClient.mascot({ type: 'motion', name: 'think-off' });
  }, [isLoading]);
  const [showDesktop, setShowDesktop] = useState(false);
  // 托盘「桌面能力…」→ 打开桌面能力面板
  useEffect(() => desktopClient.onOpenPanel(() => setShowDesktop(true)), []);
  const [showHub, setShowHub] = useState(false);
  const [hubTab, setHubTab] = useState<HubTab>('kb');
  useEffect(
    () =>
      desktopClient.onOpenSchedule(() => {
        setHubTab('schedule');
        setShowHub(true);
      }),
    [],
  );
  const [showScreen, setShowScreen] = useState(false);
  const [showExt, setShowExt] = useState(false);
  const [showLocal, setShowLocal] = useState(false);
  const [screenSt, setScreenSt] = useState<ScreenState | null>(null);
  const [screenPausedExpired, setScreenPausedExpired] = useState(false);
  useEffect(() => {
    if (!screenClient.available()) return;
    void screenClient
      .state()
      .then(setScreenSt)
      .catch(() => undefined);
    const off1 = screenClient.onChanged(setScreenSt);
    const off2 = screenClient.onOpenPanel(() => setShowScreen(true));
    return () => {
      off1();
      off2();
    };
  }, []);
  // 根据 pausedUntil 的时间点驱动「暂停已过期」标志，避免在渲染期调用 Date.now()
  useEffect(() => {
    const until = screenSt?.settings.pausedUntil ?? 0;
    const delay = until - Date.now();
    if (delay <= 0) {
      // 已过期：异步切到 true，避免同步 setState 触发级联渲染

      setScreenPausedExpired(true);
      return;
    }
    // 未到期：先置 false，再在到期后翻为 true
    setScreenPausedExpired(false);
    const tid = window.setTimeout(() => setScreenPausedExpired(true), delay);
    return () => window.clearTimeout(tid);
  }, [screenSt?.settings.pausedUntil]);
  const screenActive = !!screenSt?.settings.enabled && screenPausedExpired;
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
    setShowHub(false);
    setShowScreen(false);
    setShowExt(false);
    setShowLocal(false);
    setShowDesktop(false);
    setSettings(sec);
  }, []);
  // 托盘「模型设置…」→ 设置 →「模型」
  useEffect(() => providerClient.onOpenPanel(() => openSettings('models')), [openSettings]);
  useEffect(() => watchNomiModel(), []);
  // 看板娘「TTS 语音配置」/ 语音错误「去设置」→ 设置 → 语音与屏幕 → 语音
  useEffect(
    () => desktopClient.onOpenVoiceSettings(() => openSettings('senses', 'voice')),
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
    async (id: string) => {
      const store = ipcClient.conversationStore?.();
      if (!store) return;
      try {
        const r = await forkSameBackend(store, id);
        if (r.backend !== 'nomi') setMode('dev');
        if (r.tabId) await tabs.activate(r.tabId);
        else {
          if (tabs.available) await tabs.activate('main');
          await actions.loadChatHistory();
        }
        // 激活 / 重载后再广播一次：侧栏列表只在消息数变化时才会自刷新
        notifyConversationsChanged();
        setToast(t('已分叉为「{0}」', r.title));
      } catch (e) {
        setToast(e instanceof Error ? e.message : String(e));
      }
    },
    [ipcClient, setMode, tabs, actions],
  );

  const runForkCross = useCallback(
    async (id: string, target: ConversationBackend, cwd?: string) => {
      const store = ipcClient.conversationStore?.();
      if (!store) return;
      setForkCross(null);
      try {
        const r = await forkCrossBackend(store, id, target, { cwd });
        if (r.backend !== 'nomi') setMode('dev');
        if (r.tabId) await tabs.activate(r.tabId);
        else {
          if (tabs.available) await tabs.activate('main');
          await actions.loadChatHistory();
        }
        notifyConversationsChanged();
        setToast(t('已分叉到 {0}', r.title));
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
      if (mode === 'same') void runForkSame(id);
      else if (isDev) setForkCross({ id, backend: meta.backend }); // 普通模式不允许分叉到其他端
    },
    [ipcClient, runForkSame, isDev],
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
      hub: () => setShowHub((v) => !v),
      ext: () => setShowExt((v) => !v),
      local: () => setShowLocal((v) => !v),
      screen: () => setShowScreen((v) => !v),
      newTab: () => {
        if (!isDev) return;
        setTabNew((n) => n + 1);
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
        if (!isDev) return;
        setTabRename((n) => n + 1);
      },
    }),
    [newChat, focusInput, tabs, isDev],
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
      screen: mk('senses', 'screen'),
      ext: mk('ext'),
      desktop: mk('privacy', 'desktop'),
      local: mk('local'),
    };
  }, [openSettings]);

  const handleNewChat = () => {
    actions.newConversation();
  };

  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      ...SHORTCUT_DEFS.filter((d) => d.id !== 'palette' && shortcutActions[d.id]).map((d) => ({
        id: d.id,
        label: d.label,
        group: '操作',
        hint: formatCombo(bindings[d.id]),
        run: shortcutActions[d.id]!,
      })),
      ...SETTINGS_SECTIONS.map((sec) => ({
        id: `settings-${sec.id}`,
        label: sec.label,
        group: '设置',
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
  const tabSend = tabs.send;
  const tabCancel = tabs.cancel;
  const inputModeProps = useMemo(
    () =>
      cliActive
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
            busyOverride: cliActive.status === 'running' || cliActive.status === 'queued',
            imageCapability: cliImageSupport(cliActive.backend),
            placeholder: cliTabPlaceholder(cliActive),
            queue: {
              onQueue: (text: string) => void tabSend(text),
              onStop: () => void tabCancel(),
            },
          }
        : { queue: { onQueue: nomiQueue.enqueue } },
    [cliActive, tabSend, tabCancel, nomiQueue.enqueue],
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
  const openHub = useCallback(() => setShowHub(true), []);
  const closeHub = useCallback(() => setShowHub(false), []);
  const openScreen = useCallback(() => setShowScreen(true), []);
  const closeScreen = useCallback(() => setShowScreen(false), []);
  const openExt = useCallback(() => setShowExt(true), []);
  const closeExt = useCallback(() => setShowExt(false), []);
  const openLocal = useCallback(() => setShowLocal(true), []);
  const closeLocal = useCallback(() => setShowLocal(false), []);
  const closeSettings = useCallback(() => setSettings(null), []);

  const paletteEl = (
    <CommandPalette open={palette} onClose={() => setPalette(false)} commands={paletteCommands} />
  );

  return (
    <div className="ai-chat-app">
      <ChatBackgroundLayer />
      <AppTitleBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
      />
      {/* 会话树保活：打开设置时只隐藏（display:none）不卸载，避免关闭时整树冷重挂载导致卡顿、
          草稿/滚动位置丢失与 IPC 订阅重建 */}
      <div className={settings ? 'chat-keepalive-hidden' : 'chat-keepalive'}>
        {/* 侧边栏 */}
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
          showToggle={!hasAppTitleBar()}
          onNewChat={handleNewChat}
          onForkRequest={onForkRequest}
          onNotice={setToast}
          onOpenSettings={(sec) => openSettings(sec)}
          footer={
            <AppEntries
              collapsed={sidebarCollapsed}
              onHub={() => setShowHub(true)}
              onExt={() => setShowExt(true)}
              onLocal={() => setShowLocal(true)}
              onSettings={() => openSettings()}
            />
          }
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
                    minWidth: CHAT_COL_W_MIN,
                    maxWidth: CHAT_COL_W_MAX,
                    // 窗口不够时先压对话列（到 MIN），不把中栏挤没
                    flexShrink: 1,
                  }
                : {}),
            }}
          >
            <ChatHeader
              tabs={
                isDev ? (
                  <ChatTabs
                    embedded
                    renameRequest={tabRename}
                    newTabRequest={tabNew}
                    mainLoading={isLoading}
                    onForkTab={(tabId, mode) => {
                      const meta = ipcClient.conversationStore?.()?.findByTabId(tabId);
                      if (meta) onForkRequest(meta.id, mode);
                    }}
                  />
                ) : undefined
              }
              trailing={
                railTabId ? (
                  <FilesRailToggle
                    open={railOpen}
                    count={sessionChangeCount}
                    onToggle={toggleRail}
                  />
                ) : undefined
              }
            >
              {screenActive && (
                <button
                  type="button"
                  className="screen-mem-indicator"
                  onClick={() => setShowScreen(true)}
                  title={t('屏幕记忆开启中（仅保存在本机），点击管理或暂停')}
                  data-testid="screen-mem-indicator"
                >
                  <span className="screen-mem-dot" />
                  {t('屏幕记忆中')}
                </button>
              )}
            </ChatHeader>
            {/* 对话区域 */}
            <main className="chat-container">
              {isDev && tabs.isCliTab ? (
                <>
                  {tabs.messages.length === 0 &&
                  !tabs.live[tabs.activeTab!.id] &&
                  slash.cards.length === 0 &&
                  tabs.activeTab!.status === 'idle' ? (
                    <div className="welcome-screen" data-testid="cli-tab-empty">
                      <div className="welcome-content">
                        <h2 className="welcome-title">
                          {t('{0} · 新会话', tabs.activeTab!.title)}
                        </h2>
                        <p className="welcome-subtitle">
                          {t('消息会转发给本机编程助手；多个标签可以同时运行。')}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <ConversationView
                      scopeId={tabs.activeTab!.id}
                      messages={cliConvMessages}
                      live={tabLiveToConv(tabs.live[tabs.activeTab!.id])}
                      phase={
                        tabs.activeTab!.status === 'running'
                          ? 'running'
                          : tabs.activeTab!.status === 'queued'
                            ? 'queued'
                            : 'idle'
                      }
                      queued={tabs.queues[tabs.activeTab!.id]}
                      onRemoveQueued={tabs.removeQueued}
                      onPermission={(id, allow) => void tabs.replyPermission(id, allow)}
                      onRetry={(id) => {
                        const u = precedingUser(tabs.messages, id);
                        if (u) void tabs.send(u.content);
                      }}
                      onEdit={(_, text) => void tabs.send(text)}
                      slots={cliSlots}
                      cards={slash.cards}
                      onDismissCard={slash.dismissCard}
                      dormant={tabs.activeTab!.dormant}
                      backgroundAgents={tabs.activeTab!.backgroundAgents}
                      backgroundCount={tabs.activeTab!.background}
                      onStopAgent={(agentId) =>
                        void harnessClient
                          .stopAgent(tabs.activeTab!.id, agentId)
                          .catch(() => undefined)
                      }
                    />
                  )}
                </>
              ) : messageCount === 0 && slash.cards.length === 0 ? (
                <div className="welcome-screen" data-testid="welcome-screen">
                  <div className="welcome-content">
                    <h2 className="welcome-title">{t('今天想做点什么？')}</h2>
                    <div className="quick-actions">
                      {[
                        [t('你好，请介绍一下自己'), t('打个招呼')],
                        [t('帮我写一段代码'), t('写一段代码')],
                        [t('帮我整理今天的待办'), t('整理今天的待办')],
                      ].map(([prompt, label]) => (
                        <button
                          key={label}
                          className="quick-action-btn"
                          onClick={() => actions.sendMessage(prompt)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="welcome-subtitle">
                      {t('输入 / 查看命令 · ＋ 打开知识库、语音、模型与设置')}
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
                onScreenClick={openScreen}
                onExtClick={openExt}
                onLocalClick={openLocal}
              />
              {/* 输入框下方：工作目录与供应商 / 账号（不再浮在消息上方压住正文） */}
              <div className="session-bar">
                <SessionControls
                  onManageNomi={() => openSettings('models')}
                  onOpenModels={() => openSettings('models')}
                />
              </div>
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
                title={t('拖动调整对话与变更 Diff 宽度；双击恢复默认')}
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
              title={t('拖动调整聊天与工作区宽度；双击恢复默认')}
            />
            <aside
              className="files-rail"
              data-testid="files-rail"
              style={{
                width: filesRailWidth,
                minWidth: FILES_RAIL_W_MIN,
                maxWidth: FILES_RAIL_W_MAX,
                flexShrink: 0,
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
      <HubPanel
        isVisible={showHub}
        onClose={closeHub}
        tab={hubTab}
        onTab={setHubTab}
        onOpenSettings={openSettings}
      />
      <ModalHostContext.Provider value={drawerHost.screen}>
        <ScreenPanel isVisible={showScreen} onClose={closeScreen} />
      </ModalHostContext.Provider>
      <ModalHostContext.Provider value={drawerHost.ext}>
        <ExtensionsPanel isVisible={showExt} onClose={closeExt} />
      </ModalHostContext.Provider>
      <ModalHostContext.Provider value={drawerHost.local}>
        <LocalPanel isVisible={showLocal} onClose={closeLocal} tabs={LOCAL_TABS} />
      </ModalHostContext.Provider>
      <ForkTargetMenu
        open={!!forkCross}
        current={forkCross?.backend ?? 'nomi'}
        onClose={() => setForkCross(null)}
        onPick={(b, cwd) => forkCross && void runForkCross(forkCross.id, b, cwd)}
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
      </AiChatContextProvider>
    </ErrorBoundary>
  );
}

export default App;
