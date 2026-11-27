import { t } from '@nomi-ai/ui';
import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';

import type { AiChatActionsValue, AiChatState } from '../../contexts/AiChatContext';
import type { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useSessionPanes } from '../../contexts/SessionPanesContext';
import { api } from '../../services/api';
import type { ConversationStore } from '../../services/conversationStore';
import { MAIN_TAB_ID, harnessClient, type HarnessTabMeta } from '../../services/harnessClient';
import type { HistorySession } from '../../services/historyClient';
import { updateManagedConversationMeta } from '../../services/managedMainChat';
import { clearNomiAutoTitle } from '../../services/sessionTitle';
import { cliTranscriptKey } from '../../services/transcriptView';
import type { ConversationBackend } from '../../types/chat';
import { startSessionPaneDrag } from '../../utils/sessionPaneDrag';
import {
  canDropSessionOnSide,
  cliSessionKey,
  nomiSessionKey,
  type SessionPaneSide,
} from '../../utils/sessionPanes';
import { confirmDialog } from '../ConfirmDialog';

import type { Meta } from './types';

type Tabs = ReturnType<typeof useHarnessTabs>;
type Ipc = AiChatState['ipcClient'];
type Actions = AiChatActionsValue['actions'];

/** 会话菜单的位置；从「更多」按钮打开时带上按钮（再点它关掉菜单） */
export type MenuAt = { x: number; y: number; anchor?: HTMLElement };
export type ContextMenuAt = MenuAt & { id: string };
export type HistoryMenuAt = MenuAt & { h: HistorySession };

/** 会话行对应的主区会话键：Nomi 用 nomi:<id>，CLI 标签用 cliSessionKey（与 useActiveSessionInfo 一致） */
function sessionKeyOfMeta(meta: Meta, tabs: readonly HarnessTabMeta[] | undefined): string | null {
  if (meta.tabId) {
    const tab = tabs?.find((x) => x.id === meta.tabId);
    if (tab) return cliSessionKey(tab);
    return cliTranscriptKey({
      id: meta.tabId,
      backend: meta.backend,
      cliSessionId: meta.cliSessionId ?? null,
    });
  }
  return nomiSessionKey(meta.id);
}

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
  /** 「向右打开」：右面板打开这个会话（左面板不动）；没给时不显示菜单项 */
  onOpenToSide?: (sessionKey: string | null) => void;
  /** 拖放分屏：把会话放到主区左半或右半 */
  onOpenOnSide?: (sessionKey: string | null, side: SessionPaneSide) => void;
  /** 单击会话时让主区焦点面板指向它（openSessionInFocus）；没给时整块不动（独立渲染侧栏） */
  onOpenInFocus?: (sessionKey: string | null) => void;
  /** 开始拖动会话行时收起悬停预览卡片 */
  onDragActivate?: () => void;
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
  onOpenToSide,
  onOpenOnSide,
  onOpenInFocus,
  onDragActivate,
}: SidebarSessionsOptions) {
  const sessionPanes = useSessionPanes();
  const panesRef = useRef(sessionPanes);
  const dragActivateRef = useRef(onDragActivate);
  // 行回调读最新的 list / current / tabs（经 ref），回调本身保持稳定：
  // 否则每次渲染换引用，ThreadItem 的 React.memo 全部失效
  const latest = useRef({
    list,
    current,
    tabs,
    isDev,
    removeItem: undefined as ((id: string) => Promise<void>) | undefined,
    archiveItem: undefined as ((id: string) => Promise<void>) | undefined,
    onOpenToSide,
    onOpenOnSide,
    openInFocus: onOpenInFocus,
    /** 共用的会话存储（已拆分时切会话前看左边是不是 Nomi 会话） */
    store: undefined as ConversationStore | undefined,
  });

  // 经 ref 调用：回调保持稳定，不让 ThreadItem 的 memo 失效
  const leaveRef = useRef(onLeavePage);
  useLayoutEffect(() => {
    leaveRef.current = onLeavePage;
  }, [onLeavePage]);

  /**
   * 侧栏单击会话：先让主区的**焦点面板**指向它（openSessionInFocus：已开在某个面板里就只聚焦那个面板，
   * 否则只换焦点面板的会话），另一个面板（含另一个工程的会话）不动；再把「当前会话」切过去。
   * 没有会话面板（独立渲染侧栏 / 测试）时不调，行为与原来一致。
   */
  const focusPanelOn = (meta: Meta, tabs: Tabs) => {
    const openInFocus = latest.current.openInFocus;
    if (!openInFocus) return;
    openInFocus(sessionKeyOfMeta(meta, tabs.state?.tabs));
  };

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
      focusPanelOn(meta, tabs);

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

  /**
   * 拖放分屏 / 「向右打开」：把会话放到主区左半或右半（右半时另一边不动，左半时新会话在左）；
   * 再把「当前会话」切过去（与单击一样）。
   */
  const openOnSide = useCallback(
    async (id: string, side: SessionPaneSide) => {
      setCtx(null);
      if (!ipc) return;
      leaveRef.current?.();
      const { list, tabs } = latest.current;
      const meta = list.find((x) => x.id === id);
      if (!meta) return;
      const key = sessionKeyOfMeta(meta, tabs.state?.tabs);
      if (latest.current.onOpenOnSide) latest.current.onOpenOnSide(key, side);
      else if (side === 'right') latest.current.onOpenToSide?.(key);
      actions.clearDone?.(id);
      if (meta.backend !== 'nomi' && meta.tabId) {
        await tabs.activate(meta.tabId).catch(() => undefined);
        await ipc.switchConversation(id).catch(() => undefined);
        refresh();
        return;
      }
      // Nomi 会话：若当前还停在 CLI 标签则切回 Nomi 主标签，再把指针切到目标会话
      const keep = latest.current.tabs.state?.tabs.find((x) => x.id === MAIN_TAB_ID);
      if (latest.current.tabs.available && latest.current.tabs.state?.activeTabId !== MAIN_TAB_ID)
        void latest.current.tabs.activate(MAIN_TAB_ID);
      if (harnessClient.available() && keep?.backend !== 'nomi')
        void harnessClient.setBackend('nomi').catch(() => undefined);
      if (id !== ipc.currentConversationId?.()) {
        await ipc.switchConversation(id);
        await actions.loadChatHistory();
      }
      refresh();
    },
    [ipc, refresh, actions, setCtx],
  );

  const openToSide = useCallback((id: string) => openOnSide(id, 'right'), [openOnSide]);

  const onDragPointerDown = useCallback(
    (id: string, e: React.PointerEvent) => {
      const { list, tabs, onOpenOnSide: toSideOpt, onOpenToSide: rightOpt } = latest.current;
      if (!toSideOpt && !rightOpt) return;
      const meta = list.find((x) => x.id === id);
      if (!meta) return;
      const key = sessionKeyOfMeta(meta, tabs.state?.tabs);
      if (!key) return;
      const title = meta.name ? t(meta.name) : t('ui.chat-settings.new-chat');
      startSessionPaneDrag(e, {
        id,
        sessionKey: key,
        title,
        canDrop: (side) => {
          const panes = panesRef.current;
          if (!panes) return true;
          return canDropSessionOnSide(
            { panes: [...panes.panes], focusedPaneId: panes.focusedPaneId },
            key,
            side,
          );
        },
        onActivate: () => dragActivateRef.current?.(),
        onDrop: (side) => void openOnSide(id, side),
      });
    },
    [openOnSide],
  );

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
        const store = ipc.conversationStore?.();
        if (store?.isManaged?.(id)) {
          void updateManagedConversationMeta(api, id, { name })
            .then(() => store.refreshManaged?.(id))
            .then(() => refresh())
            .catch(() => undefined);
          return;
        }
        store?.updateMeta(id, { name });
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
    if (store.isManaged?.(id)) {
      await updateManagedConversationMeta(api, id, { archivedAt: Date.now() }).catch(
        () => undefined,
      );
      await store.refreshManaged?.(id);
      store.advanceFromArchived?.(id);
    } else {
      store.setArchived(id, true);
    }
    if (id === current) {
      if (ipc?.currentConversationId?.()) await actions.loadChatHistory();
      else await actions.clearChatHistory();
    }
    onNotice?.(t('ui.cli-monitor.chat-archived', t(meta.name)));
    refresh();
  };

  useLayoutEffect(() => {
    panesRef.current = sessionPanes;
    dragActivateRef.current = onDragActivate;
    latest.current = {
      ...latest.current,
      list,
      current,
      tabs,
      isDev,
      removeItem,
      archiveItem,
      onOpenToSide,
      onOpenOnSide,
      openInFocus: onOpenInFocus,
      store: ipc?.conversationStore?.(),
    };
  });

  // 行内仅保留置顶；归档与删除在更多菜单中操作。
  const togglePin = useCallback(
    (id: string) => {
      const meta = latest.current.list.find((x) => x.id === id);
      const store = ipc?.conversationStore?.();
      if (!meta || !store) return;
      if (store.isManaged?.(id)) {
        void updateManagedConversationMeta(api, id, {
          pinnedAt: meta.pinnedAt ? null : Date.now(),
        })
          .then(() => store.refreshManaged?.(id))
          .then(() => refresh())
          .catch(() => undefined);
        return;
      }
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
    openToSide,
    openOnSide,
    onDragPointerDown: onOpenOnSide || onOpenToSide ? onDragPointerDown : undefined,
    /** 有会话面板「向右打开」回调时菜单里才显示「向右打开」 */
    canOpenToSide: !!(onOpenToSide || onOpenOnSide),
  };
}
