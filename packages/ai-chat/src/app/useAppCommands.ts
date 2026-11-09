/**
 * 对话窗口的命令：分叉（同端 / 跨端，⌘⇧F 直接分叉当前会话）、快捷键（可在设置 → 快捷键 改绑；
 * 标签切换 Ctrl+Tab、Mod+1…9）与 ⌘K 命令面板。分叉的目标选择框与命令面板由调用方渲染。
 */
import { t } from '@nomi-ai/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { PaletteCommand } from '../components/CommandPalette';
import type { ForkPick } from '../components/ForkMenu';
import { SETTINGS_SECTIONS } from '../components/SettingsView/sections';
import type { AiChatActions } from '../contexts/AiChatContext';
import type { HarnessTabsCore } from '../contexts/HarnessTabsContext';
import type { ChatMode } from '../services/chatPrefs';
import { notifyConversationsChanged } from '../services/conversationStore';
import { forkCrossBackend, forkSameBackend } from '../services/forkConversation';
import { openProjectTerminal } from '../services/openProjectTerminal';
import {
  RENAME_CHAT_EVENT,
  SEARCH_CHATS_EVENT,
  SHORTCUT_DEFS,
  formatCombo,
  isMac,
  matchShortcut,
  useShortcutBindings,
  type ShortcutId,
} from '../services/shortcuts';
import type { ConversationBackend } from '../types/chat';
import type { IPCClient } from '../types/ipc';

import type { AppPanels } from './useAppPanels';

export interface ForkTarget {
  /** 源会话 */
  id: string;
  backend: ConversationBackend;
  /** 源会话的项目（分叉弹窗里项目的默认值） */
  projectId?: string;
  /** 从这条消息分叉：只带到它为止，之后的丢掉 */
  upto?: string;
}

export function useAppCommands(opts: {
  actions: AiChatActions;
  ipcClient: IPCClient;
  tabs: HarnessTabsCore;
  isDev: boolean;
  setMode: (m: ChatMode) => void;
  panels: AppPanels;
  setToast: (msg: string) => void;
  /** 「在终端打开当前项目」用的目录 */
  cwd: string | null;
}) {
  const { actions, ipcClient, tabs, isDev, setMode, panels, setToast, cwd } = opts;
  const { setSettings, openSettings, toggleSettings, toggleSidebar, expandSidebar } = panels;
  const { toggleHub, toggleExt, openLocal } = panels;
  const bindings = useShortcutBindings();
  const [palette, setPalette] = useState(false);
  const closePalette = useCallback(() => setPalette(false), []);
  const [forkTarget, setForkTarget] = useState<ForkTarget | null>(null);
  const closeFork = useCallback(() => setForkTarget(null), []);
  // 切到普通模式时关掉分叉弹窗（目标端可能已不可选；渲染期根据 isDev 变化重置，避免 effect 内 setState 级联渲染）
  const [prevIsDev, setPrevIsDev] = useState(isDev);
  if (prevIsDev !== isDev) {
    setPrevIsDev(isDev);
    if (!isDev && forkTarget) setForkTarget(null);
  }

  const focusInput = useCallback(() => {
    setSettings(null);
    setTimeout(
      () => document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')?.focus(),
      0,
    );
  }, [setSettings]);
  const newChat = useCallback(() => {
    setSettings(null);
    actions.newConversation();
    focusInput();
  }, [actions, focusInput, setSettings]);

  /** 分叉完：切到新会话（CLI 标签或主对话），再广播一次（侧栏只在消息数变化时自刷新） */
  const runFork = useCallback(
    async (id: string, target: ConversationBackend | null, pick: ForkPick & { upto?: string }) => {
      const store = ipcClient.conversationStore?.();
      if (!store) return;
      setForkTarget(null);
      try {
        const r = target
          ? await forkCrossBackend(store, id, target, pick)
          : await forkSameBackend(store, id, pick);
        if (r.backend !== 'nomi') setMode('dev');
        if (r.tabId) await tabs.activate(r.tabId);
        else {
          if (tabs.available) await tabs.activate('main');
          await actions.loadChatHistory();
        }
        notifyConversationsChanged();
        setToast(t(target ? 'ui.cli-monitor.forked-to' : 'ui.cli-monitor.forked-as', r.title));
      } catch (e) {
        setToast(e instanceof Error ? e.message : String(e));
      }
    },
    [ipcClient, setMode, tabs, actions, setToast],
  );
  const runForkSame = useCallback((id: string) => runFork(id, null, {}), [runFork]);
  /** 分叉弹窗选好：同一个端 = 新会话，否则分叉到那个端 */
  const pickFork = useCallback(
    (b: ConversationBackend, pick: ForkPick) => {
      if (!forkTarget) return;
      const p = { ...pick, ...(forkTarget.upto ? { upto: forkTarget.upto } : {}) };
      void runFork(forkTarget.id, b === forkTarget.backend ? null : b, p);
    },
    [forkTarget, runFork],
  );
  /** 打开分叉弹窗。upto：从这条消息分叉（消息末尾的「分叉」），之后的消息不带 */
  const onForkRequest = useCallback(
    (id: string, opts: { upto?: string } = {}) => {
      const meta = ipcClient.conversationStore?.()?.get(id);
      if (!meta) return;
      const tab = tabs.activeTab;
      const tabProject = meta.tabId && tab && tab.id === meta.tabId ? tab.projectId : undefined;
      setForkTarget({
        id,
        backend: meta.backend,
        projectId: meta.projectId ?? tabProject,
        upto: opts.upto,
      });
    },
    [ipcClient, tabs],
  );
  /** 消息末尾的「分叉」：当前显示的会话从这条消息往前分叉 */
  const forkFromMessage = useCallback(
    (messageId: string) => {
      const store = ipcClient.conversationStore?.();
      const tabId = isDev && tabs.isCliTab ? tabs.activeTab?.id : undefined;
      const id = tabId
        ? store?.list().find((c: { tabId?: string }) => c.tabId === tabId)?.id
        : ipcClient.currentConversationId?.();
      if (id) onForkRequest(id, { upto: messageId });
    },
    [ipcClient, isDev, tabs, onForkRequest],
  );
  // ⌘⇧F：直接把当前会话分叉成新对话
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
        expandSidebar();
        window.dispatchEvent(new Event(SEARCH_CHATS_EVENT));
      },
      focusInput,
      settings: toggleSettings,
      sidebar: toggleSidebar,
      hub: toggleHub,
      ext: toggleExt,
      local: openLocal,
      newTab: () => {
        if (!isDev) return;
        // 按当前会话的端和项目直接新开；Nomi 会话则新开对话（其它端从侧栏的新建菜单选）
        const cur = tabs.activeTab;
        if (cur && cur.backend !== 'nomi')
          void tabs.create(cur.backend, cur.projectId).catch(() => undefined);
        else newChat();
      },
      closeTab: () => {
        if (isDev && tabs.activeTab) void tabs.close(tabs.activeTab.id);
      },
      nextTab: () => {
        if (isDev) tabs.cycle(1);
      },
      prevTab: () => {
        if (isDev) tabs.cycle(-1);
      },
      renameTab: () => {
        // 在侧栏的会话列表里给当前会话改名
        if (isDev) window.dispatchEvent(new Event(RENAME_CHAT_EVENT));
      },
      // 在终端打开当前会话的工作目录（services/openProjectTerminal）
      openTerminal: () => openProjectTerminal(cwd, setToast),
    }),
    [
      newChat,
      focusInput,
      tabs,
      isDev,
      cwd,
      setToast,
      expandSidebar,
      toggleSettings,
      toggleSidebar,
      toggleHub,
      toggleExt,
      openLocal,
    ],
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

  return {
    palette,
    closePalette,
    paletteCommands,
    forkTarget,
    closeFork,
    pickFork,
    onForkRequest,
    forkFromMessage,
    isDev,
  };
}
