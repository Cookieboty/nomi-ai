import { byCli } from '@nomi-ai/cli-catalog';
import { t, Icon, useLocale, usePresence } from '@nomi-ai/ui';
import { MessagesSquare, SquarePen } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { List } from 'react-window';

import {
  selectIpcClient,
  selectIsLoading,
  selectMessageCount,
  useAiChatActions,
  useAiChatSelector,
} from '../../contexts/aiChatStore';
import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import { useCliHistory } from '../../hooks/useCliHistory';
import { useCliTabSync } from '../../hooks/useCliTabSync';
import { useConversationListView } from '../../hooks/useConversationListView';
import { MAX_RESULTS, useHistorySearchIndex } from '../../hooks/useHistorySearchIndex';
import { useNewProject } from '../../hooks/useNewProject';
import { orderEndpoints, visibleEndpoints } from '../../services/chatPrefs';
import { cliUpdateClient } from '../../services/cliUpdateClient';
import {
  CONVERSATIONS_CHANGED_EVENT,
  OPEN_CONVERSATION_EVENT,
} from '../../services/conversationStore';
import {
  MAIN_TAB_ID,
  harnessClient,
  isNomiDelegated,
  type HarnessTabMeta,
} from '../../services/harnessClient';
import {
  HISTORY_BACKENDS,
  isHistoryBackend,
  type HistoryBackend,
  type HistorySession,
} from '../../services/historyClient';
import { useProjects, type Project } from '../../services/projects';
import { clearNomiAutoTitle } from '../../services/sessionTitle';
import { formatCombo, useShortcutBindings } from '../../services/shortcuts';
import { CONVERSATION_BACKENDS, type ConversationBackend } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import { rankItems } from '../../utils/fuzzy';
import { isImeComposing } from '../../utils/keyboard';
import { ChatModeSwitch } from '../ChatModeSwitch';
import { confirmDialog } from '../ConfirmDialog';
import { ConversationMenu } from '../ConversationMenu';
import { EndpointInfoCard } from '../EndpointInfo';
import { GettingStarted } from '../GettingStarted';
import { NewChatMenu } from '../NewChatMenu';
import { ProjectDialog } from '../ProjectDialog';
import type { SettingsSection, SettingsTab } from '../SettingsView/sections';

import { AnchoredPopover } from './AnchoredPopover';
import { EndpointRail } from './EndpointRail';
import styles from './index.module.css';
import { sameMetaList } from './listEquality';
import { LocalHistorySection } from './LocalHistorySection';
import { useProjectGrouping, projectBackend } from './projectGrouping';
import {
  OrganizeMenu,
  PinnedSection,
  ProjectGroups,
  SECTION_PINNED,
  SECTION_WORKSPACES,
} from './ProjectGroups';
import { SearchDialog } from './SearchDialog';
import {
  firstUserMessageCache,
  fieldsOf,
  useDebounced,
  SearchIcon,
  type SearchEntry,
} from './searchSupport';
import { SectionHeader } from './SectionHeader';
import { SessionPeek, useSessionPeek } from './SessionPeek';
import { ThreadItem, VirtualRow } from './SidebarRows';
import { SideNavItem } from './SideNavItem';
import type { Meta } from './types';
import { useFloatingPanel } from './useFloatingPanel';
import { useSessionActions } from './useSessionActions';
import { useSidebarRename, useSidebarSearchShortcut } from './useSidebarRename';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  /** projectId：新 Nomi 对话放进哪个项目（null = 不放进项目；不给 = 沿用当前对话的） */
  onNewChat: (opts?: { projectId?: string | null }) => void | Promise<void>;
  /** 打开分叉弹窗（新会话或其他端在弹窗里选） */
  onForkRequest?: (id: string) => void;
  /** 打开历史会话失败 / 有提示时 */
  onNotice?: (message: string) => void;
  /** 跳到设置的某个分区 / 标签：「按端」信息卡、「开始使用」清单 */
  onOpenSettings?: (section: SettingsSection, tab?: SettingsTab) => void;
  /** 侧栏底部的应用级入口（设置 / 知识 / 扩展 / 本机），由 App 传入 */
  footer?: React.ReactNode;
  /** 会话列表上方的固定入口（素材库），由 App 传入 */
  topNav?: React.ReactNode;
  /** topNav 里的整页（任务 / 素材库）正打开着：会话行不再显示选中，免得侧栏同时亮两处 */
  pageOpen?: boolean;
  /** 点会话、新建会话、打开历史会话：先关掉 topNav 的整页，回到对话（点的就是当前会话也回去） */
  onLeavePage?: () => void;
  /** 搜索窗里打开某个任务 / 素材（任务页 / 素材库） */
  onOpenTask?: (id: string) => void;
  onOpenAsset?: (file: string) => void;
}

/** 侧栏：全部 / 按端 + 端点徽标；点击按后端路由到主对话或 CLI 标签 */
/** 会话菜单的位置；从「更多」按钮打开时带上按钮（再点它关掉菜单） */
type MenuAt = { x: number; y: number; anchor?: HTMLElement };

const SidebarImpl: React.FC<SidebarProps> = ({
  collapsed,
  onToggle,
  onNewChat,
  onForkRequest,
  onNotice,
  onOpenSettings,
  footer,
  topNav,
  pageOpen,
  onLeavePage,
  onOpenTask,
  onOpenAsset,
}) => {
  // Sidebar 是 React.memo，props 稳定时不随根组件重渲染：自己订阅语言，切换后文案才会刷新
  useLocale();
  const { actions } = useAiChatActions();
  const ipc = useAiChatSelector(selectIpcClient);
  const messageCount = useAiChatSelector(selectMessageCount);
  const isLoading = useAiChatSelector(selectIsLoading);
  const tabs = useHarnessTabs();
  const { isDev, isNormal, setMode } = useChatMode();
  const {
    view: storedView,
    setView,
    endpointFilter,
    setEndpointFilter,
    endpointVisibility,
    setEndpointVisibility,
    endpointOrder,
    setEndpointOrder,
    groupByWorkspace,
    setGroupByWorkspace,
    collapsedWorkspaces,
    setWorkspaceCollapsed,
  } = useConversationListView();
  // 普通模式只有 Nomi：视图固定为「全部」，但不改动已保存的选择，切回开发模式即恢复
  const view = isNormal ? 'all' : storedView;
  const bindings = useShortcutBindings();
  const [list, setList] = useState<Meta[]>([]);
  const [current, setCurrent] = useState<string | undefined>();
  const [bins, setBins] = useState<Record<string, string | null>>({});
  const [newMenu, setNewMenu] = useState(false);
  // anchor：从行内「更多」按钮打开时是那个按钮（再点它关掉菜单）；右键打开时没有
  const [ctx, setCtx] = useState<(MenuAt & { id: string }) | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [histMenu, setHistMenu] = useState<(MenuAt & { h: HistorySession }) | null>(null);
  // 菜单收起时先放完淡出动画再卸载
  const newMenuP = usePresence(newMenu && !collapsed);
  const ctxP = usePresence(ctx);
  const histMenuP = usePresence(histMenu);
  const ws = useNewProject();
  const projects = useProjects();
  // 创建 / 编辑项目的弹窗：'new' = 新建
  const [projectDialog, setProjectDialog] = useState<Project | 'new' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const newBtnRef = useRef<HTMLButtonElement>(null);
  const newPopRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    if (!ipc?.listConversations) return;
    void ipc
      .listConversations()
      .then((l) => {
        const next = [...l].sort((a, b) => b.updatedAt - a.updatedAt);
        // 内容没变就保留旧引用：否则每次刷新都让依赖 list 的 memo 与所有行重算
        setList((prev) => (sameMetaList(prev, next) ? prev : next));
        setCurrent(ipc.currentConversationId?.());
      })
      .catch(() => undefined);
  }, [ipc]);

  useCliTabSync(refresh);
  // 分叉等外部操作改了会话列表：立即刷新（否则要等下一次消息数 / 加载状态变化）
  useEffect(() => {
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, refresh);
  }, [refresh]);
  // loading 变化时也刷新：首个会话在第一条消息保存时才创建，发送结束后需要让它出现在列表里
  useEffect(refresh, [refresh, messageCount, isLoading]);

  // 本机装了哪些 CLI：打开时取一次；在 Nomi 里装 / 更新完、或回到窗口时（可能刚在终端里装了）再取
  useEffect(() => {
    if (!harnessClient.available()) return;
    const load = () =>
      void harnessClient
        .state()
        .then((s) => setBins(s.bins))
        .catch(() => undefined);
    load();
    const off = cliUpdateClient.onEvent((e) => {
      if (e.phase === 'done') load();
    });
    window.addEventListener('focus', load);
    return () => {
      off();
      window.removeEventListener('focus', load);
    };
  }, [isDev]);

  useEffect(() => {
    if (!newMenu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      const target = e instanceof MouseEvent ? (e.target as Node) : null;
      if (target && (menuRef.current?.contains(target) || newPopRef.current?.contains(target)))
        return;
      setNewMenu(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [newMenu]);

  const tabById = useMemo(() => {
    const m = new Map<string, HarnessTabMeta>();
    // Nomi 主对话正在回复时也算「进行中」（主标签自身的状态不反映 Nomi 的生成）
    for (const x of tabs.state?.tabs ?? [])
      m.set(x.id, x.id === MAIN_TAB_ID && isLoading ? { ...x, status: 'running' } : x);
    return m;
  }, [tabs.state, isLoading]);

  // 高亮项：工作台模式下当前在 CLI 标签时以标签为准。新建标签不会切换 Nomi 当前会话，
  // 只看 currentConversationId 会让高亮停在之前打开的那一项上
  const activeTabId = tabs.state?.activeTabId;
  const highlightId =
    isDev && activeTabId && activeTabId !== MAIN_TAB_ID
      ? list.find((x) => x.tabId === activeTabId)?.id
      : current;
  const rowActiveId = pageOpen ? undefined : highlightId;
  const float = useFloatingPanel(collapsed);
  // 会话面板收起时先放完收回动画再卸载
  const panelP = usePresence(!collapsed || float.floating);
  // 浮层里选了会话 / 新建了会话（高亮换了）：收起浮层
  const [floatFor, setFloatFor] = useState(highlightId);
  if (floatFor !== highlightId) {
    setFloatFor(highlightId);
    if (float.floating) float.hide();
  }

  // 普通模式：侧栏只列 Nomi 会话（CLI 标签仍在后台运行，切回开发模式即可看到）
  const navList = useMemo(() => {
    // 归档的对话不在侧栏显示（设置 → Nomi → 已归档的对话 里找回）
    const shown = list.filter((x) => !x.archivedAt);
    const source = isNormal ? shown.filter((x) => x.backend === 'nomi') : shown;
    // 标签状态是 CLI 标题的即时来源。同步落盘在 useCliTabSync 的 effect 中完成，
    // 这里先直接使用最新标签标题，避免侧栏短暂继续显示 Grok 1 / Codex 2。
    return source.map((c) => {
      const title = c.tabId ? tabById.get(c.tabId)?.title : undefined;
      return title && title !== c.name ? { ...c, name: title } : c;
    });
  }, [list, isNormal, tabById]);

  const counts = useMemo(() => {
    const c: Record<ConversationBackend, number> = { nomi: 0, ...byCli(() => 0), external: 0 };
    for (const x of navList) c[x.backend] = (c[x.backend] ?? 0) + 1;
    return c;
  }, [navList]);

  // 左下角信息卡跟随当前会话所在的端（CLI 标签 / Nomi 对话）；点了顶部端点图标就先看那个端，
  // 直到切换会话。还没有当前会话时退回筛选的端
  const [cardPick, setCardPick] = useState<ConversationBackend | null>(null);
  const startRename = useSidebarRename(collapsed, onToggle, highlightId, setRenamingId);
  const [cardPickFor, setCardPickFor] = useState(highlightId);
  if (cardPickFor !== highlightId) {
    setCardPickFor(highlightId);
    setCardPick(null);
  }
  const cardBackend: ConversationBackend =
    cardPick ?? navList.find((x) => x.id === highlightId)?.backend ?? endpointFilter;
  // 该端的运行中 / 排队中标签数与最近一次标签活动（信息卡用）
  const { endpointRunning, endpointLastTab } = useMemo(() => {
    let running = 0;
    let last: number | null = null;
    for (const x of tabs.state?.tabs ?? []) {
      if (x.backend !== cardBackend || isNomiDelegated(x)) continue;
      if (x.status === 'running' || x.status === 'queued') running++;
      if (last == null || x.updatedAt > last) last = x.updatedAt;
    }
    return { endpointRunning: running, endpointLastTab: last };
  }, [tabs.state, cardBackend]);

  const visible = useMemo(() => {
    if (view === 'by-endpoint') return navList.filter((x) => x.backend === endpointFilter);
    return navList;
  }, [navList, view, endpointFilter]);

  // 置顶的会话单独放在最上面的「置顶」里（按置顶先后），其余照常分组 / 平铺
  const { pinned, unpinned } = useMemo(() => {
    const p = visible.filter((c) => c.pinnedAt);
    p.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
    return { pinned: p, unpinned: p.length ? visible.filter((c) => !c.pinnedAt) : visible };
  }, [visible]);
  const wsGroups = useProjectGrouping(unpinned, projects, tabById, groupByWorkspace);

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
      const { list, current, tabs, isDev } = latest.current;
      const meta =
        list.find((x) => x.id === id) ?? (await ipc.listConversations()).find((x) => x.id === id);
      if (!meta) return;
      setCtx(null);

      if (meta.backend !== 'nomi' && meta.tabId) {
        if (!isDev) setMode('dev');
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
    [ipc, setMode, refresh, actions],
  );
  // 别处请求打开会话（Agent 看板里正在回答的 Nomi 对话）
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === 'string' && id) void open(id);
    };
    window.addEventListener(OPEN_CONVERSATION_EVENT, on);
    return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, on);
  }, [open]);

  /** projectId：指定项目（项目行上的「新建」）；null = 不放进项目；缺省用新建菜单里选的项目 */
  const createFor = async (backend: ConversationBackend, projectId?: string | null) => {
    setNewMenu(false);
    leaveRef.current?.();
    const pid = projectId === undefined ? (ws.chosen ?? null) : projectId;
    ws.reset(); // 菜单里选的项目只管这一次新建，不带到下一次
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
      if (!isDev) setMode('dev');
      if (!tabs.available) return;
      await tabs.create(backend, pid ?? undefined);
      refresh();
    } catch (e) {
      onNotice?.(t('ui.cli-monitor.new-chat-failed', e instanceof Error ? e.message : String(e)));
    }
  };

  const handleNewClick = () => {
    if (isNormal) {
      void createFor('nomi');
      return;
    }
    if (view === 'by-endpoint') {
      void createFor(endpointFilter);
      return;
    }
    setNewMenu((v) => !v);
  };

  const removeItem = async (id: string) => {
    setCtx(null);
    const meta = list.find((x) => x.id === id);
    if (!meta || !ipc) return;
    if (meta.tabId) {
      const st = tabById.get(meta.tabId)?.status;
      if (
        (st === 'running' || st === 'queued') &&
        !(await confirmDialog({
          message: t('ui.mascot-theme.this-tab-is-still-running-closing-it-will'),
        }))
      )
        return;
      await tabs.close(meta.tabId);
    } else {
      // 永久删除不能撤销：先确认，并提示可以改用归档
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
    [ipc, refresh],
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

  // 行内按钮：CLI 标签 = 关闭（可从历史重新打开，运行中先确认）；Nomi 对话 = 归档
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
  const requestDelete = useCallback((id: string) => {
    const { list, removeItem, archiveItem } = latest.current;
    const meta = list.find((x) => x.id === id);
    if (!meta) return;
    void (meta.tabId ? removeItem : archiveItem)?.(id);
  }, []);
  const listPeek = useSessionPeek(400);

  /** 行内「更多」：与右键共用同一个 ConversationMenu，只是锚在按钮下方 */
  const openMore = useCallback((id: string, anchor: HTMLElement) => {
    setNewMenu(false);
    setHistMenu(null);
    const a = anchor.getBoundingClientRect();
    // 再点同一个「更多」按钮：关掉菜单
    setCtx((cur) =>
      cur?.anchor === anchor ? null : { id, x: a.right - 184, y: a.bottom + 2, anchor },
    );
  }, []);

  const onCtx = useCallback((id: string, e: React.MouseEvent) => {
    e.preventDefault();
    setNewMenu(false);
    setCtx({ id, x: e.clientX, y: e.clientY });
  }, []);

  const cliMissing = (b: ConversationBackend) => b !== 'nomi' && !bins[b];

  // 开发模式：磁盘上的 CLI 历史会话（每端 50 条一页）
  const histBackends = useMemo(() => HISTORY_BACKENDS.filter((b) => Boolean(bins[b])), [bins]);
  const tabsKey = (tabs.state?.tabs ?? []).map((x) => `${x.id}:${x.cliSessionId ?? ''}`).join('|');
  const history = useCliHistory(isDev, histBackends, tabsKey);
  const {
    openingKey,
    openHistory: openHistoryRaw,
    deleteHistory,
    deleteTab,
  } = useSessionActions({
    tabs,
    onNotice,
    refresh,
    refreshHistory: history.refresh,
  });
  const openHistory = useCallback(
    (h: Parameters<typeof openHistoryRaw>[0]) => {
      leaveRef.current?.();
      return openHistoryRaw(h);
    },
    [openHistoryRaw],
  );
  // 镜像条目与本机历史使用同一个稳定键：CLI 后端 + 原生会话 id。
  // 主进程会尽量提前排除已打开的会话，但这里还要防住历史扫描与标签同步的竞态，
  // 也要覆盖搜索索引返回得比侧栏列表更早的情况。
  const openSessionKeys = useMemo(() => {
    const keys = new Set(
      list.filter((c) => c.tabId && c.cliSessionId).map((c) => `${c.backend}:${c.cliSessionId}`),
    );
    // 标签状态先于 ConversationStore 镜像到达时，也要立即隐藏本机历史。
    for (const tab of tabs.state?.tabs ?? []) {
      if (tab.id !== MAIN_TAB_ID && tab.cliSessionId)
        keys.add(`${tab.backend}:${tab.cliSessionId}`);
    }
    return keys;
  }, [list, tabs.state]);
  const historyItems = useCallback(
    (backend?: HistoryBackend) => history.items(backend).filter((h) => !openSessionKeys.has(h.key)),
    [history, openSessionKeys],
  );
  const histScope: HistoryBackend | undefined =
    view === 'by-endpoint' && endpointFilter !== 'nomi'
      ? (endpointFilter as HistoryBackend)
      : undefined;
  // 磁盘历史扫描由主进程按各 CLI 的本地格式完成，包含 Grok 的 updates.jsonl。
  const histScopeSupported =
    histScope === undefined || (HISTORY_BACKENDS as readonly string[]).includes(histScope);
  const histItems: HistorySession[] =
    !histScopeSupported || (view === 'by-endpoint' && endpointFilter === 'nomi')
      ? []
      : historyItems(histScope);

  // 侧栏「按端」：对话数（CLI 标签已镜像进对话列表）+ 磁盘历史；都为 0 且没有显式设置的端点不显示
  const endpointActivity = useMemo(() => {
    const a: Partial<Record<ConversationBackend, number>> = { ...counts };
    for (const b of histBackends) a[b] = (a[b] ?? 0) + historyItems(b).length;
    return a;
  }, [counts, histBackends, historyItems]);
  const shownEndpoints = useMemo(() => {
    const shown = visibleEndpoints(
      CONVERSATION_BACKENDS,
      endpointVisibility,
      endpointActivity,
      (b) => Boolean(bins[b]),
    );
    // 正在看的端点（没被显式隐藏）始终保留，避免数据还没加载完时按钮跳动
    if (!shown.includes(endpointFilter) && endpointVisibility[endpointFilter] !== 'hide')
      return CONVERSATION_BACKENDS.filter((b) => b === endpointFilter || shown.includes(b));
    return shown;
  }, [endpointVisibility, endpointActivity, endpointFilter, bins]);
  // 导航栏够高：全部端点按顺序竖排（Nomi 最前，其余按自定义顺序或对话数）
  const railEndpoints = useMemo(
    () => orderEndpoints(shownEndpoints, endpointActivity, endpointOrder),
    [shownEndpoints, endpointActivity, endpointOrder],
  );
  const pickEndpoint = (b: ConversationBackend) => {
    setCardPick(b);
    setEndpointFilter(b);
    setView('by-endpoint');
    // 切到另一个端：打开它正在运行（或排队）的会话；没有就打开列表里第一条；一条都没有就新建一个空对话
    // （没安装的 CLI 只切筛选）。已经停在这个端的会话上就不动
    if (navList.find((x) => x.id === highlightId)?.backend === b) return;
    const items = navList.filter((x) => x.backend === b);
    const busy = (x: (typeof items)[number]) => {
      const st = x.tabId ? tabById.get(x.tabId)?.status : undefined;
      return st === 'running' || st === 'queued';
    };
    const target = items.find(busy) ?? items[0];
    if (target) void open(target.id);
    else if (!cliMissing(b)) void createFor(b);
  };

  // 端点图标的悬停提示：名称 + 对话数 + 本机历史数（只列非 0 的）
  const endpointTip = (b: ConversationBackend): string => {
    const hist = (histBackends as readonly string[]).includes(b)
      ? historyItems(b as HistoryBackend).length
      : 0;
    return [
      ENDPOINT_FULL[b](),
      counts[b] ? t('ui.cli-monitor.conversations', counts[b]) : '',
      hist ? t('ui.cli-monitor.local-sessions', hist) : '',
      cliMissing(b) ? t('ui.mascot-theme.not-installed') : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };
  // 本机历史随当前筛选合在同一个列表里：Nomi 没有磁盘历史，不显示
  const histVisible =
    isDev &&
    history.available &&
    histBackends.length > 0 &&
    histScopeSupported &&
    !(view === 'by-endpoint' && endpointFilter === 'nomi');
  const histScanning = histVisible && histItems.length === 0 && history.loading && !history.loaded;

  // ── 模式切换：普通模式下当前会话若是 CLI 会话，自动换到最近的 Nomi 会话（没有则新建）；
  //    切回开发模式时回到离开前选中的会话。CLI 标签一直在后台运行。
  const leftDevOn = useRef<string | null>(null);
  const redirecting = useRef(false);
  const currentMeta = list.find((x) => x.id === current);
  useEffect(() => {
    if (isDev) {
      const back = leftDevOn.current;
      leftDevOn.current = null;
      if (back && back !== current && list.some((x) => x.id === back)) void open(back);
      return;
    }
    if (!currentMeta || currentMeta.backend === 'nomi' || redirecting.current || !list.length)
      return;
    redirecting.current = true;
    leftDevOn.current = currentMeta.id;
    const nomi = list.find((x) => x.backend === 'nomi');
    // 一次性的模式切换重定向（受 redirecting 保护），不会级联渲染
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void (nomi ? open(nomi.id) : createFor('nomi')).finally(() => {
      redirecting.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDev, currentMeta?.id, currentMeta?.backend, list.length]);

  // ── 搜索：图标按钮 → 原位展开为搜索框；Mod+F 聚焦；Esc 清空 / 收起；150ms 防抖
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounced = useDebounced(query, 150);
  const searching = searchOpen && debounced.trim() !== '';
  const searchIndex = useHistorySearchIndex(isDev && searching, histBackends, tabsKey);

  useSidebarSearchShortcut(setSearchOpen, inputRef);
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);
  // 普通 / 开发模式切换后端点范围变了，丢掉光标（在渲染期根据键变化重置，避免 effect 内 setState 触发级联渲染）
  const activeIdxKey = `${debounced}\u0001${isDev ? 1 : 0}\u0001${view}\u0001${endpointFilter}`;
  const [prevActiveIdxKey, setPrevActiveIdxKey] = useState(activeIdxKey);
  if (prevActiveIdxKey !== activeIdxKey) {
    setPrevActiveIdxKey(activeIdxKey);
    if (activeIdx !== 0) setActiveIdx(0);
  }

  const firstUserMessage = useCallback(
    (m: Meta): string => {
      if (m.tabId) return '';
      const k = `${m.id}:${m.updatedAt}`;
      const hit = firstUserMessageCache.get(k);
      if (hit !== undefined) return hit;
      let text = '';
      try {
        // 只取预览。getMessages 会把整段历史留在缓存里，搜索一次就会钉住列表里的全部对话。
        text = ipc?.conversationStore?.()?.firstUserPreview?.(m.id) ?? '';
      } catch {
        /* 取不到就只搜标题 */
      }
      if (firstUserMessageCache.size > 2000) firstUserMessageCache.clear();
      firstUserMessageCache.set(k, text);
      return text;
    },
    [ipc],
  );

  const results = useMemo(() => {
    if (!searching) return [];
    const seen = new Set<string>();
    const entries: SearchEntry[] = [];
    for (const m of visible) {
      seen.add(m.id);
      entries.push({
        kind: 'conv',
        id: m.id,
        meta: m,
        title: m.name ? t(m.name) : t('ui.chat-settings.new-chat'),
        first: firstUserMessage(m),
        cwd: (m.tabId ? tabById.get(m.tabId)?.cwd : '') ?? '',
      });
    }
    if (isDev && histScopeSupported && !(view === 'by-endpoint' && endpointFilter === 'nomi')) {
      // 已加载的分页 + 搜索索引合并，同一会话（backend:sessionId）只保留一条
      for (const h of [...historyItems(histScope), ...searchIndex.items]) {
        if (histScope && h.backend !== histScope) continue;
        if (openSessionKeys.has(h.key)) continue;
        if (seen.has(h.key)) continue;
        seen.add(h.key);
        entries.push({ kind: 'hist', id: h.key, h });
      }
    }
    return rankItems(entries, debounced, fieldsOf);
  }, [
    searching,
    visible,
    tabById,
    isDev,
    view,
    endpointFilter,
    historyItems,
    openSessionKeys,
    histScope,
    histScopeSupported,
    searchIndex.items,
    debounced,
    firstUserMessage,
  ]);
  const shown = results.slice(0, MAX_RESULTS);
  const activeEntry = shown[Math.min(activeIdx, Math.max(shown.length - 1, 0))]?.item;

  const openEntry = (e: SearchEntry | undefined) => {
    if (!e) return;
    closeSearch();
    if (e.kind === 'conv') void open(e.id);
    else void openHistory(e.h);
  };
  const closeSearch = () => {
    setQuery('');
    setSearchOpen(false);
  };
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (query) setQuery('');
      else closeSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(shown.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && !isImeComposing(e.nativeEvent)) {
      e.preventDefault();
      openEntry(activeEntry);
    }
  };
  useEffect(() => {
    if (!searching) return;
    document
      .getElementById(`sb-result-${Math.min(activeIdx, Math.max(shown.length - 1, 0))}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIdx, searching, shown.length]);

  const canSearchMore = isDev && searchIndex.hasMore;
  // 「按端」时新建跟随当前筛选的端，提示里写明
  const newLabel =
    isDev && view === 'by-endpoint'
      ? t('ui.cli-monitor.new-named-conversation', ENDPOINT_FULL[endpointFilter]())
      : t('ui.chat-settings.new-chat');
  const newTip = [newLabel, formatCombo(bindings.newChat)].join(' ');
  const searchTip = [
    t('ui.cli-monitor.search-conversations'),
    formatCombo(bindings.searchChats),
  ].join(' ');

  const newBtn = (
    <div className={styles.newWrap} ref={menuRef}>
      <button
        ref={newBtnRef}
        className={collapsed ? styles.iconBtn : styles.headBtn}
        onClick={handleNewClick}
        title={newTip}
        aria-label={t('ui.chat-settings.new-chat')}
        aria-haspopup={isDev && view === 'all' ? 'menu' : undefined}
        aria-expanded={isDev && view === 'all' ? newMenu : undefined}
        data-testid="new-chat"
      >
        <Icon icon={SquarePen} size={14} />
      </button>
      {newMenuP.value && (
        <AnchoredPopover anchor={newBtnRef.current} popRef={newPopRef}>
          <NewChatMenu
            closing={newMenuP.closing}
            className={styles.newMenu}
            backends={CONVERSATION_BACKENDS}
            bins={bins}
            strictBins
            project={ws}
            onPick={(b) => void createFor(b)}
          />
        </AnchoredPopover>
      )}
    </div>
  );

  // 新建项目（不开对话）：打开「创建项目」弹窗
  const newProjectBtn = (
    <button
      type="button"
      className={styles.headBtn}
      onClick={() => setProjectDialog('new')}
      title={t('ui.cli-monitor.project-create-title')}
      aria-label={t('ui.cli-monitor.project-create-title')}
      data-testid="new-project"
    >
      <Icon icon={SquarePen} size={14} />
    </button>
  );
  // 「项目」标题右侧：整理「…」+ 新建项目；分组时不放通用新建（项目行上有，搜索窗口与快捷键也有）。
  // 不分组时（「对话」）：整理 + 新建对话
  const listOpen = !collapsedWorkspaces.includes(SECTION_WORKSPACES);
  const organize = <OrganizeMenu grouped={groupByWorkspace} onChange={setGroupByWorkspace} />;
  const listActions = wsGroups.grouped ? (
    <>
      {organize}
      {newProjectBtn}
    </>
  ) : (
    <>
      {organize}
      {newBtn}
    </>
  );

  // react-window 按浅比较 rowProps 决定是否重渲染行：对象本身也要稳定
  const rowProps = useMemo(
    () => ({
      items: unpinned,
      current: highlightId,
      tabById,
      open,
      onCtx,
      renamingId,
      onRename: commitRename,
      onPinToggle: togglePin,
      onDeleteRequest: requestDelete,
      onMore: openMore,
      onPeek: listPeek.onPeek,
      showIcon: isDev && view === 'all',
    }),
    [
      visible,
      highlightId,
      tabById,
      open,
      onCtx,
      renamingId,
      commitRename,
      requestDelete,
      openMore,
      listPeek.onPeek,
      isDev,
      view,
    ],
  );

  return (
    <aside
      className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}
      data-testid="chat-sidebar"
      data-panel={collapsed ? undefined : 'open'} // 展开：与右边对话卡片拼成一张（App.css）
      onMouseEnter={float.floating ? float.cancelHide : undefined}
      onMouseLeave={collapsed ? float.scheduleHide : undefined}
    >
      {/* 左侧固定导航：对话 · 任务 · 素材库；工作台模式下端点竖排挂在下面；底部是应用级入口 */}
      <div className={styles.rail} data-testid="app-rail">
        <nav className={styles.railNav} aria-label={t('ui.foundation.app-shortcuts')}>
          {/* 收起时悬停 / 聚焦「对话」弹出会话浮层 */}
          <span
            className={styles.railHover}
            onMouseEnter={collapsed ? float.show : undefined}
            onFocus={collapsed ? float.show : undefined}
          >
            <SideNavItem
              icon={MessagesSquare}
              label={t('ui.chat-settings.chats')}
              collapsed
              active={!pageOpen}
              onOpen={() => {
                leaveRef.current?.();
                if (collapsed) float.show();
              }}
              testId="nav-chats"
            />
          </span>
          {topNav}
        </nav>
        {isDev && (
          <span
            className={styles.railHover}
            onMouseEnter={collapsed ? float.show : undefined}
            onFocus={collapsed ? float.show : undefined}
          >
            <EndpointRail
              allActive={view === 'all'}
              active={view === 'by-endpoint' ? endpointFilter : null}
              shown={railEndpoints}
              ordered={orderEndpoints(CONVERSATION_BACKENDS, endpointActivity, endpointOrder)}
              activity={endpointActivity}
              visibility={endpointVisibility}
              customOrder={endpointOrder !== null}
              isDisabled={cliMissing}
              tipOf={endpointTip}
              onAll={() => setView('all')}
              onPick={pickEndpoint}
              onReorder={setEndpointOrder}
              onVisibility={(b, v) => {
                setEndpointVisibility(b, v);
                // 隐藏了正在看的端点：回到「全部」，免得筛选停在看不见的端点上
                if (v === 'hide' && b === endpointFilter && view === 'by-endpoint') setView('all');
              }}
            />
          </span>
        )}
        <span className={styles.railSpacer} />
        {footer}
      </div>

      {panelP.value && (
        <div
          className={`${styles.panel} ${float.floating ? styles.panelFloating : ''}`}
          data-testid="sidebar-panel"
          data-floating={float.floating || undefined}
          data-closing={panelP.closing || undefined}
          aria-hidden={panelP.closing || undefined}
        >
          {/* 顶行（Codex 式）：模式菜单在左，搜索在右；新建与整理在「工作区」标题右侧 */}
          <div className={styles.top}>
            <ChatModeSwitch />
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.headBtn}
              onClick={() => setSearchOpen(true)}
              title={searchTip}
              aria-label={t('ui.cli-monitor.search-conversations')}
              data-testid="sidebar-search-toggle"
            >
              <SearchIcon />
            </button>
          </div>

          <nav
            className={styles.threads}
            aria-label={t('ui.chat-settings.history')}
            data-testid="conversation-list"
            onScroll={listPeek.hide}
          >
            {onOpenSettings && (
              <GettingStarted
                mode={isDev ? 'workbench' : 'assistant'}
                hasChats={list.length > 0 || histItems.length > 0}
                onOpenSettings={onOpenSettings}
                onStart={handleNewClick}
              />
            )}
            {visible.length === 0 && !(histVisible && histItems.length > 0) && !histScanning && (
              <div className={styles.empty} data-testid="conversation-list-empty">
                {t('ui.chat-settings.no-past-conversations')}
              </div>
            )}
            {pinned.length > 0 && (
              <PinnedSection
                items={pinned}
                open={!collapsedWorkspaces.includes(SECTION_PINNED)}
                onToggle={(open) => setWorkspaceCollapsed(SECTION_PINNED, open)}
                activeId={rowActiveId}
                rows={rowProps}
              />
            )}
            {wsGroups.grouped && (
              <ProjectGroups
                groups={wsGroups.groups}
                rest={wsGroups.rest}
                collapsed={collapsedWorkspaces}
                onToggleCollapsed={setWorkspaceCollapsed}
                onNewIn={(g) =>
                  void createFor(projectBackend(g, isNormal, view, endpointFilter), g.project.id)
                }
                onEdit={(g) => setProjectDialog(g.project)}
                activeId={rowActiveId}
                rows={rowProps}
                headerActions={listActions}
                hideEmpty={isDev && view === 'by-endpoint'}
              />
            )}
            {!wsGroups.grouped && (
              <SectionHeader
                label={t('ui.chat-settings.chats')}
                open={listOpen}
                onToggle={() => setWorkspaceCollapsed(SECTION_WORKSPACES, listOpen)}
                testId="list-section-toggle"
                actions={listActions}
              />
            )}
            {!wsGroups.grouped &&
              listOpen &&
              unpinned.length > 0 &&
              unpinned.length <= 100 &&
              unpinned.map((c) => (
                <ThreadItem
                  key={c.id}
                  c={c}
                  active={c.id === rowActiveId}
                  tab={c.tabId ? tabById.get(c.tabId) : undefined}
                  onOpen={open}
                  onCtx={onCtx}
                  renaming={renamingId === c.id}
                  onRename={commitRename}
                  onPinToggle={togglePin}
                  onDeleteRequest={requestDelete}
                  onMore={openMore}
                  onPeek={listPeek.onPeek}
                  showIcon={isDev && view === 'all'}
                />
              ))}
            {!wsGroups.grouped && listOpen && unpinned.length > 100 && (
              <div
                style={{ height: '100%', minHeight: 320 }}
                data-testid="conversation-list-virtual"
              >
                <List
                  rowCount={unpinned.length}
                  rowHeight={34}
                  rowComponent={VirtualRow}
                  rowProps={rowProps}
                  style={{ height: '100%', width: '100%' }}
                />
              </div>
            )}
            {histVisible && (histItems.length > 0 || histScanning) && (
              <LocalHistorySection
                items={histItems}
                scanning={histScanning}
                openingKey={openingKey}
                onOpen={(h) => void openHistory(h)}
                onMenu={(h, x, y, anchor) => {
                  setNewMenu(false);
                  setCtx(null);
                  // 再点同一个「更多」按钮：关掉菜单
                  setHistMenu((cur) =>
                    anchor && cur?.anchor === anchor ? null : { h, x, y, anchor },
                  );
                }}
                onDelete={(h) => void deleteHistory(h)}
                hasMore={histScopeSupported && history.hasMore(histScope)}
                loading={history.loading}
                onLoadMore={() => history.loadMore(histScope)}
                onRefresh={history.refresh}
              />
            )}
          </nav>

          {/* 工作台模式：左下角固定一张当前会话所在端的信息卡（点击打开详情抽屉） */}
          {isDev && (
            <EndpointInfoCard
              backend={cardBackend}
              running={endpointRunning}
              lastTabActivity={endpointLastTab}
              bin={
                cardBackend === 'nomi'
                  ? undefined
                  : (bins[cardBackend] ?? (cardBackend in bins ? null : undefined))
              }
              onOpenSettings={onOpenSettings}
            />
          )}
        </div>
      )}

      {ctxP.value &&
        (() => {
          const ctx = ctxP.value;
          const meta = list.find((x) => x.id === ctx.id);
          return (
            <ConversationMenu
              // 换了一行右键：重新挂载，焦点回到新菜单的第一项
              key={`${ctx.id}:${ctx.x}:${ctx.y}`}
              closing={ctxP.closing}
              anchor={ctx.anchor}
              x={ctx.x}
              y={ctx.y}
              isTab={Boolean(meta?.tabId)}
              onDismiss={() => setCtx(null)}
              onRename={() => startRename(ctx.id)}
              onPin={meta ? () => togglePin(ctx.id) : undefined}
              pinned={Boolean(meta?.pinnedAt)}
              onFork={() => onForkRequest?.(ctx.id)}
              onClose={meta?.tabId ? () => void removeItem(ctx.id) : undefined}
              onArchive={meta && !meta.tabId ? () => void archiveItem(ctx.id) : undefined}
              // CLI 标签：删除 = 关标签 + 把 CLI 的会话记录移到废纸篓（外部 CLI 没有本机历史，只能关闭）
              onDelete={
                !meta?.tabId
                  ? () => void removeItem(ctx.id)
                  : isHistoryBackend(meta.backend)
                    ? () => void deleteTab(meta)
                    : undefined
              }
            />
          );
        })()}

      {listPeek.peek &&
        (() => {
          const c = visible.find((x) => x.id === listPeek.peek?.id);
          if (!c) return null;
          const { top, left } = listPeek.peek;
          const tab = c.tabId ? tabById.get(c.tabId) : undefined;
          return (
            <SessionPeek
              c={c}
              tab={tab}
              top={top}
              left={left}
              onRename={commitRename}
              onHold={listPeek.hold}
              onRelease={listPeek.release}
            />
          );
        })()}

      {projectDialog && (
        <ProjectDialog
          project={projectDialog === 'new' ? undefined : projectDialog}
          onClose={() => setProjectDialog(null)}
        />
      )}
      {searchOpen && (
        <SearchDialog
          query={query}
          onQuery={setQuery}
          inputRef={inputRef}
          onKeyDown={onSearchKey}
          onClose={closeSearch}
          searching={searching}
          shown={shown}
          total={results.length}
          max={MAX_RESULTS}
          activeIdx={activeIdx}
          onActive={setActiveIdx}
          indexing={searchIndex.loading}
          canSearchMore={canSearchMore}
          onSearchMore={searchIndex.more}
          openingKey={openingKey}
          tabById={tabById}
          onOpenConv={(id) => (closeSearch(), void open(id))}
          onOpenHist={(h) => (closeSearch(), void openHistory(h))}
          onCtx={onCtx}
          recent={navList.slice(0, 6)}
          newLabel={newLabel}
          newHint={formatCombo(bindings.newChat)}
          onNew={handleNewClick}
          onOpenTask={onOpenTask}
          onOpenAsset={onOpenAsset}
        />
      )}

      {histMenuP.value && (
        <ConversationMenu
          x={histMenuP.value.x}
          y={histMenuP.value.y}
          isTab={false}
          closing={histMenuP.closing}
          anchor={histMenuP.value.anchor}
          onDismiss={() => setHistMenu(null)}
          onOpen={() => void openHistory(histMenuP.value!.h)}
          onDelete={() => void deleteHistory(histMenuP.value!.h)}
        />
      )}
    </aside>
  );
};

/** memo：App 每次渲染（流式输出、标签进度）不再连带重渲染整个侧栏 */
export const Sidebar = React.memo(SidebarImpl);
