import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import * as AISdkReact from '@nomi-ai/ai-sdk-client/react';
import { t } from '@nomi-ai/ui';
import { ModalHostContext, type ModalHost } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { ChatHeader } from './components/ChatHeader';
import { ChatTabs, cliTabPlaceholder } from './components/ChatTabs';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { ConversationView } from './components/Conversation';
import { nomiSlots } from './components/Conversation/nomiSlots';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ForkTargetMenu } from './components/ForkMenu';
import type { HubTab } from './components/HubPanel';
import {
  ConfigPanel,
  DesktopPanel,
  ExtensionsPanel,
  HubPanel,
  LocalPanel,
  ProviderPanel,
  ScreenPanel,
  SettingsView,
  prefetchPanels,
} from './components/lazyPanels';
import { MessageInput } from './components/MessageInput';
import { OnboardingHost } from './components/Onboarding';
import { onboardingClient } from './components/Onboarding/client';
import {
  LOCAL_MANAGE_TABS,
  SETTINGS_SECTIONS,
  type SettingsSection,
  type SettingsTab,
} from './components/SettingsView/sections';
import { Sidebar } from './components/Sidebar';
import { AppTitleBar } from './components/TitleBar';
import { AiChatContextProvider } from './contexts/AiChatContext';
import { useAiChat } from './contexts/AiChatContext';
import { HarnessTabsProvider, useHarnessTabs } from './contexts/HarnessTabsContext';
import { useChatMode } from './hooks/useChatMode';
import { useSendQueue } from './hooks/useSendQueue';
import { setProviderEndpoint } from './services/chatPrefs';
import { desktopClient } from './services/desktopClient';
import { forkCrossBackend, forkSameBackend } from './services/forkConversation';
import { providerClient } from './services/providerClient';
import { screenClient, type ScreenState } from './services/screenClient';
import {
  SEARCH_CHATS_EVENT,
  SHORTCUT_DEFS,
  formatCombo,
  isMac,
  matchShortcut,
  useShortcutBindings,
  type ShortcutId,
} from './services/shortcuts';
import type { ConversationBackend } from './types/chat';
import { isConversationBackend } from './types/chat';
import { fromHarnessMessage, splitNomiMessages, tabLiveToConv } from './utils/convAdapters';
import './App.css';

const AiChatContent: React.FC = () => {
  const { state, actions } = useAiChat();
  const tabs = useHarnessTabs();
  const { isDev, setMode } = useChatMode();
  // ───── 统一会话视图的数据：Nomi 主对话与编程助手标签走同一个 ConversationView ─────
  const nomiConv = useMemo(
    () => splitNomiMessages(state.messages, state.isLoading),
    [state.messages, state.isLoading],
  );
  const cliBackend = tabs.activeTab?.backend ?? 'claude';
  const cliConvMessages = useMemo(
    () => (tabs.isCliTab ? tabs.messages.map((m) => fromHarnessMessage(m, cliBackend)) : []),
    [tabs.isCliTab, tabs.messages, cliBackend],
  );
  const nomiQueue = useSendQueue(
    state.isLoading,
    (text) => actions.sendStreamMessage(text),
    state.messages[0]?.id,
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
  const [showConfig, setShowConfig] = useState(false);
  const [showProviders, setShowProviders] = useState(false);

  // 托盘「Provider 设置…」→ 主进程通知打开面板
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
  useEffect(() => providerClient.onOpenPanel(() => setShowProviders(true)), []);
  // mascot holds a thinking pose while a reply is being generated
  useEffect(() => {
    if (!state.isLoading) return;
    onboardingClient.mascot({ type: 'motion', name: 'think-on' });
    return () => onboardingClient.mascot({ type: 'motion', name: 'think-off' });
  }, [state.isLoading]);
  const [showDesktop, setShowDesktop] = useState(false);
  // 托盘「桌面能力…」→ 打开桌面能力面板
  useEffect(() => desktopClient.onOpenPanel(() => setShowDesktop(true)), []);
  const [showHub, setShowHub] = useState(false);
  const [hubTab, setHubTab] = useState<HubTab>('kb');
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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    setShowConfig(false);
    setShowProviders(false);
    setSettings(sec);
  }, []);
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
      const store = state.ipcClient.conversationStore?.();
      if (!store) return;
      try {
        const r = await forkSameBackend(store, id);
        if (r.backend !== 'nomi') setMode('dev');
        if (r.tabId) await tabs.activate(r.tabId);
        else {
          if (tabs.available) await tabs.activate('main');
          await actions.loadChatHistory();
        }
        setToast(t('已分叉为「{0}」', r.title));
      } catch (e) {
        setToast(e instanceof Error ? e.message : String(e));
      }
    },
    [state.ipcClient, setMode, tabs, actions],
  );

  const runForkCross = useCallback(
    async (id: string, target: ConversationBackend, cwd?: string) => {
      const store = state.ipcClient.conversationStore?.();
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
        setToast(t('已分叉到 {0}', r.title));
      } catch (e) {
        setToast(e instanceof Error ? e.message : String(e));
      }
    },
    [state.ipcClient, setMode, tabs, actions],
  );

  const onForkRequest = useCallback(
    (id: string, mode: 'same' | 'cross') => {
      const store = state.ipcClient.conversationStore?.();
      const meta = store?.get(id);
      if (!meta) return;
      if (mode === 'same') void runForkSame(id);
      else if (isDev) setForkCross({ id, backend: meta.backend }); // 普通模式不允许分叉到其他端
    },
    [state.ipcClient, runForkSame, isDev],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (!(isMac() ? e.metaKey : e.ctrlKey) || !e.shiftKey || e.altKey || e.code !== 'KeyF')
        return;
      const id = state.ipcClient.currentConversationId?.();
      if (!id) return;
      e.preventDefault();
      void runForkSame(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.ipcClient, runForkSame]);

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
  const paletteEl = (
    <CommandPalette open={palette} onClose={() => setPalette(false)} commands={paletteCommands} />
  );

  return (
    <div className="ai-chat-app">
      <AppTitleBar />
      {/* 会话树保活：打开设置时只隐藏（display:none）不卸载，避免关闭时整树冷重挂载导致卡顿、
          草稿/滚动位置丢失与 IPC 订阅重建 */}
      <div className={settings ? 'chat-keepalive-hidden' : 'chat-keepalive'}>
        {/* 侧边栏 */}
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
          onNewChat={handleNewChat}
          onSettings={() => openSettings()}
          onForkRequest={onForkRequest}
          onNotice={setToast}
        />

        {/* 主内容区域 */}
        <div className="main-content">
          <ChatHeader
            onHub={() => setShowHub(true)}
            onExt={() => setShowExt(true)}
            onLocal={() => setShowLocal(true)}
            onSettings={() => openSettings()}
            onNewChat={handleNewChat}
            onCustomize={() => openSettings('general')}
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
          {isDev && (
            <ChatTabs
              renameRequest={tabRename}
              newTabRequest={tabNew}
              mainLoading={state.isLoading}
              onForkTab={(tabId, mode) => {
                const meta = state.ipcClient.conversationStore?.()?.findByTabId(tabId);
                if (meta) onForkRequest(meta.id, mode);
              }}
            />
          )}
          {/* 对话区域 */}
          <main className="chat-container">
            {isDev && tabs.isCliTab ? (
              <>
                {tabs.messages.length === 0 &&
                !tabs.live[tabs.activeTab!.id] &&
                tabs.activeTab!.status === 'idle' ? (
                  <div className="welcome-screen" data-testid="cli-tab-empty">
                    <div className="welcome-content">
                      <h2 className="welcome-title">{t('{0} · 新会话', tabs.activeTab!.title)}</h2>
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
                  />
                )}
              </>
            ) : state.messages.length === 0 ? (
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
              <ConversationView
                scopeId={`nomi:${state.messages[0]?.id ?? 'new'}`}
                messages={nomiConv.messages}
                live={nomiConv.live}
                phase={state.isLoading ? 'running' : 'idle'}
                queued={nomiQueue.queue}
                onRemoveQueued={nomiQueue.remove}
                onRetry={(id) => {
                  const u = precedingUser(state.messages, id);
                  if (u) void actions.resendFrom(u.id);
                }}
                onEdit={(id, text) => void actions.resendFrom(id, text)}
                slots={nomiSlots}
              />
            )}
          </main>

          {/* 输入区域 */}
          <footer className="input-container">
            <MessageInput
              {...(isDev && tabs.isCliTab
                ? {
                    onSend: (text: string) => void tabs.send(text),
                    busyOverride:
                      tabs.activeTab!.status === 'running' || tabs.activeTab!.status === 'queued',
                    placeholder: cliTabPlaceholder(tabs.activeTab!),
                    queue: {
                      onQueue: (text: string) => void tabs.send(text),
                      onStop: () => void tabs.cancel(),
                    },
                  }
                : { queue: { onQueue: nomiQueue.enqueue } })}
              onConfigClick={() => setShowConfig(true)}
              onProvidersClick={() => setShowProviders(true)}
              onSettingsClick={(sec, endpoint) => {
                if (isConversationBackend(endpoint)) setProviderEndpoint(endpoint);
                openSettings(sec);
              }}
              onDesktopClick={() => setShowDesktop(true)}
              onHubClick={() => setShowHub(true)}
              onScreenClick={() => setShowScreen(true)}
              onExtClick={() => setShowExt(true)}
              onLocalClick={() => setShowLocal(true)}
            />
          </footer>
        </div>
      </div>

      {/* 设置为覆盖层：会话树保持挂载，仅被此层盖住；关闭即瞬时回到原会话 */}
      {settings && (
        <div className="settings-overlay">
          <SettingsView
            section={settings}
            deepLink={settingsLink}
            onSection={setSettings}
            onClose={() => setSettings(null)}
          />
        </div>
      )}

      {/* 模型配置保持为弹窗；日常功能为右侧抽屉（快速视图） */}
      {paletteEl}
      <ConfigPanel isVisible={showConfig} onClose={() => setShowConfig(false)} />
      <ProviderPanel isVisible={showProviders} onClose={() => setShowProviders(false)} />
      <ModalHostContext.Provider value={drawerHost.desktop}>
        <DesktopPanel isVisible={showDesktop} onClose={() => setShowDesktop(false)} />
      </ModalHostContext.Provider>
      <HubPanel
        isVisible={showHub}
        onClose={() => setShowHub(false)}
        tab={hubTab}
        onTab={setHubTab}
        onOpenSettings={openSettings}
      />
      <ModalHostContext.Provider value={drawerHost.screen}>
        <ScreenPanel isVisible={showScreen} onClose={() => setShowScreen(false)} />
      </ModalHostContext.Provider>
      <ModalHostContext.Provider value={drawerHost.ext}>
        <ExtensionsPanel isVisible={showExt} onClose={() => setShowExt(false)} />
      </ModalHostContext.Provider>
      <ModalHostContext.Provider value={drawerHost.local}>
        <LocalPanel
          isVisible={showLocal}
          onClose={() => setShowLocal(false)}
          tabs={[...LOCAL_MANAGE_TABS]}
        />
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
            padding: '8px 14px',
            borderRadius: 10,
            background: 'var(--cd-color-surface-raised, #121a2a)',
            border: '1px solid var(--cd-color-border)',
            boxShadow: '0 8px 24px rgba(0,0,0,.35)',
            fontSize: 13,
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
          <AiChatContent />
        </HarnessTabsProvider>
        {/* 首次启动引导（未完成时覆盖在对话窗口上；设置 → 通用 可重新打开） */}
        <OnboardingHost />
      </AiChatContextProvider>
    </ErrorBoundary>
  );
}

export default App;
