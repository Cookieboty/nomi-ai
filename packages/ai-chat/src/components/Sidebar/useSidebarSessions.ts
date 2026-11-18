import { t } from '@nomi-ai/ui';
import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';

import type { AiChatActionsValue, AiChatState } from '../../contexts/AiChatContext';
import type { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { MAIN_TAB_ID, harnessClient } from '../../services/harnessClient';
import type { HistorySession } from '../../services/historyClient';
import { clearNomiAutoTitle } from '../../services/sessionTitle';
import type { ConversationBackend } from '../../types/chat';
import { confirmDialog } from '../ConfirmDialog';

import type { Meta } from './types';

type Tabs = ReturnType<typeof useHarnessTabs>;
type Ipc = AiChatState['ipcClient'];
type Actions = AiChatActionsValue['actions'];

/** 会话菜单的位置；从「更多」按钮打开时带上按钮（再点它关掉菜单） */
export type MenuAt = { x: number; y: number; anchor?: HTMLElement };
export type ContextMenuAt = MenuAt & { id: string };
export type HistoryMenuAt = MenuAt & { h: HistorySession };

interface SidebarSessionsOptions {
  ipc: Ipc;
  actions: Actions;
  list: Meta[];
  current: string | undefined;
  tabs: Tabs;
  isDev: boolean;
  refresh: () => void;
  onNewChat: (opts?: { projectId?: string | null }) => void | Promise<void>;
  onNotice?: (message: string) => void;
  onLeavePage?: () => void;
  chosenProject: string | null;
  resetChosenProject: () => void;
  deleteTab: (meta: Meta) => Promise<void>;
  tabStatusOf: (tabId: string) => string | undefined;
  setCtx: Dispatch<SetStateAction<ContextMenuAt | null>>;
  setNewMenu: Dispatch<SetStateAction<boolean>>;
  setHistMenu: Dispatch<SetStateAction<HistoryMenuAt | null>>;
  setRenamingId: Dispatch<SetStateAction<string | null>>;
}

/**
 * 会话行与菜单上的操作：打开、新建、删除、归档、重命名、置顶、右键 / 「更多」。
 * 行回调经 ref 读取最新状态，引用保持稳定，ThreadItem 的 memo 才不会失效。
 */
export function useSidebarSessions({
  ipc,
  actions,
  list,
  current,
  tabs,
  isDev,
  refresh,
  onNewChat,
  onNotice,
  onLeavePage,
  chosenProject,
  resetChosenProject,
  deleteTab,
  tabStatusOf,
  setCtx,
  setNewMenu,
  setHistMenu,
  setRenamingId,
}: SidebarSessionsOptions) {
  // 行回调读最新的 list / current / tabs（经 ref），回调本身保持稳定：
  // 否则每次渲染换引用，ThreadItem 的 React.memo 全部失效
  const latest = useRef({
    list,
    current,
    tabs,
    isDev,
    removeItem: undefined as ((id: string) => Promise<void>) | undefined,
    archiveItem: undefined as ((id: string) => Promise<void>) | undefined,
  });

  // 经 ref 调用：回调保持稳定，不让 ThreadItem 的 memo 失效
  const leaveRef = useRef(onLeavePage);
  useLayoutEffect(() => {
    leaveRef.current = onLeavePage;
  }, [onLeavePage]);

  const open = useCallback(
    async (id: string) => {
      leaveRef.current?.();
      if (!ipc) return;
      const { list, current, tabs } = latest.current;
      const meta =
        list.find((x) => x.id === id) ?? (await ipc.listConversations()).find((x) => x.id === id);
      if (!meta) return;
      setCtx(null);
      // 点开就是看过了：先把行首那个「已完成」点去掉（已经在看的会话不会重载历史）
      actions.clearDone?.(id);

      if (meta.backend !== 'nomi' && meta.tabId) {
        const activated = tabs.activate(meta.tabId);
        await ipc.switchConversation(id).catch(() => undefined);
        await activated;
        refresh();
        return;
      }

      // 先把主进程侧的标签 / 后端切换发出去（已经在 Nomi 主标签时完全不发），
      // 本地会话切换与消息加载不等它们，两边并行
      const mainTab = tabs.state?.tabs.find((x) => x.id === MAIN_TAB_ID);
      const pending: Promise<unknown>[] = [];
      if (tabs.available && tabs.state?.activeTabId !== MAIN_TAB_ID)
        pending.push(tabs.activate(MAIN_TAB_ID));
      if (harnessClient.available() && mainTab?.backend !== 'nomi')
        pending.push(harnessClient.setBackend('nomi').catch(() => undefined));
      if (id !== current) {
        await ipc.switchConversation(id);
        await actions.loadChatHistory();
      }
      await Promise.all(pending);
      refresh();
    },
    [ipc, refresh, actions, setCtx],
  );

  /** projectId：指定项目（项目行上的「新建」）；null = 不放进项目；缺省用新建菜单里选的项目 */
  const createFor = async (
    backend: ConversationBackend,
    projectId?: string | null,
    preset?: Parameters<Tabs['create']>[2],
  ) => {
    setNewMenu(false);
    leaveRef.current?.();
    const pid = projectId === undefined ? (chosenProject ?? null) : projectId;
    resetChosenProject(); // 菜单里选的项目只管这一次新建，不带到下一次
    try {
      if (backend === 'nomi') {
        if (tabs.available) await tabs.activate(MAIN_TAB_ID);
        if (harnessClient.available())
          await harnessClient.setBackend('nomi').catch(() => undefined);
        // 新建是异步操作。必须等它创建并切换到新的 Nomi 会话后再刷新侧栏，
        // 否则 ensureCurrent() 可能读到旧的 CLI 镜像项并把它改写成 Nomi。
        await onNewChat({ projectId: pid });
        refresh();
        return;
      }
      if (!tabs.available) return;
      await tabs.create(backend, pid ?? undefined, preset);
      refresh();
    } catch (e) {
      onNotice?.(t('ui.cli-monitor.new-chat-failed', e instanceof Error ? e.message : String(e)));
    }
  };

  const removeItem = async (id: string) => {
    setCtx(null);
    const meta = list.find((x) => x.id === id);
    if (!meta || !ipc) return;
    if (meta.tabId) {
      await deleteTab(meta);
    } else {
      // 永久删除不能撤销，先确认，再中止属于这个会话的回复。
      const ok = await confirmDialog({
        message: t('ui.cli-monitor.delete-chat-permanently-confirm', t(meta.name)),
        confirmLabel: t('ui.cli-monitor.delete-permanently'),
        danger: true,
      });
      if (!ok) return;
      // 先中止属于该会话的在途流：删除后它的回调不能再写回界面或记忆
      actions.abortConversation?.(id);
      await ipc.deleteConversation?.(id);
      if (id === current) {
        // store 已把当前会话切到同后端最近更新的会话；一个不剩则只清空消息区，不新建会话
        if (ipc.currentConversationId?.()) await actions.loadChatHistory();
        else await actions.clearChatHistory();
      }
    }
    refresh();
  };

  const closeItem = async (meta: Meta) => {
    if (!meta.tabId) return;
    const status = tabStatusOf(meta.tabId);
    if (
      (status === 'running' || status === 'queued') &&
      !(await confirmDialog({
        message: t('ui.mascot-theme.this-tab-is-still-running-closing-it-will'),
      }))
    )
      return;
    await tabs.close(meta.tabId);
  };

  const commitRename = useCallback(
    (id: string, name: string | null) => {
      setRenamingId(null);
      if (!name || !ipc) return;
      const { list, tabs } = latest.current;
      const meta = list.find((x) => x.id === id);
      if (!meta || meta.name === name) return;
      if (meta.tabId) void tabs.rename(meta.tabId, name).catch(() => undefined);
      else {
        clearNomiAutoTitle(id);
        ipc.conversationStore?.()?.updateMeta(id, { name });
      }
      refresh();
    },
    [ipc, refresh, setRenamingId],
  );

  /** 归档 Nomi 对话：不在侧栏显示，可在设置里恢复；是当前会话时 store 已切到同端最近的会话 */
  const archiveItem = async (id: string) => {
    setCtx(null);
    const store = ipc?.conversationStore?.();
    const meta = list.find((x) => x.id === id);
    if (!store || !meta || meta.tabId) return;
    store.setArchived(id, true);
    if (id === current) {
      if (ipc?.currentConversationId?.()) await actions.loadChatHistory();
      else await actions.clearChatHistory();
    }
    onNotice?.(t('ui.cli-monitor.chat-archived', t(meta.name)));
    refresh();
  };

  useLayoutEffect(() => {
    latest.current = { list, current, tabs, isDev, removeItem, archiveItem };
  });

  // 行内仅保留置顶；归档与删除在更多菜单中操作。
  const togglePin = useCallback(
    (id: string) => {
      const meta = latest.current.list.find((x) => x.id === id);
      const store = ipc?.conversationStore?.();
      if (!meta || !store) return;
      store.setPinned(id, !meta.pinnedAt);
      refresh();
    },
    [ipc, refresh],
  );

  /** 行内「更多」：与右键共用同一个 ConversationMenu，只是锚在按钮下方 */
  const openMore = useCallback(
    (id: string, anchor: HTMLElement) => {
      setNewMenu(false);
      setHistMenu(null);
      const a = anchor.getBoundingClientRect();
      // 再点同一个「更多」按钮：关掉菜单
      setCtx((cur) =>
        cur?.anchor === anchor ? null : { id, x: a.right - 184, y: a.bottom + 2, anchor },
      );
    },
    [setCtx, setHistMenu, setNewMenu],
  );

  const onCtx = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      setNewMenu(false);
      setCtx({ id, x: e.clientX, y: e.clientY });
    },
    [setCtx, setNewMenu],
  );

  return {
    leaveRef,
    open,
    createFor,
    removeItem,
    closeItem,
    commitRename,
    archiveItem,
    togglePin,
    openMore,
    onCtx,
  };
}
