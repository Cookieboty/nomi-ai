import { byCli } from '@nomi-ai/cli-catalog';
import { t, useLocale, usePresence } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  selectBusyConvos,
  selectDoneConvos,
  selectIpcClient,
  selectIsLoading,
  selectMessageCount,
  useAiChatActions,
  useAiChatSelector,
} from '../../contexts/aiChatStore';
import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import { useCliTabSync } from '../../hooks/useCliTabSync';
import { useConversationListView } from '../../hooks/useConversationListView';
import { useNewProject } from '../../hooks/useNewProject';
import { orderEndpoints } from '../../services/chatPrefs';
import { cliUpdateClient } from '../../services/cliUpdateClient';
import {
  CONVERSATIONS_CHANGED_EVENT,
  OPEN_CONVERSATION_EVENT,
} from '../../services/conversationStore';
import { MAIN_TAB_ID, harnessClient, type HarnessTabMeta } from '../../services/harnessClient';
import type { HistorySession } from '../../services/historyClient';
import { useProjects, type Project } from '../../services/projects';
import { formatCombo, useShortcutBindings } from '../../services/shortcuts';
import { CONVERSATION_BACKENDS, type ConversationBackend } from '../../types/chat';
import { startupBrandIntro } from '../BrandIntro/state';
import { EndpointInfoCard } from '../EndpointInfo';
import { GettingStarted } from '../GettingStarted';
import type { SettingsSectionInput, SettingsTab } from '../SettingsView/sections';

import styles from './index.module.css';
import { sameMetaList } from './listEquality';
import { NewChatButton } from './NewChatButton';
import { useProjectGrouping, projectBackend, pinnedFirst } from './projectGrouping';
import { NewProjectButton, OrganizeMenu, SECTION_WORKSPACES } from './ProjectGroups';
import { useProjectPeek } from './ProjectPeek';
import { SearchIcon } from './searchSupport';
import { useSessionPeek } from './SessionPeek';
import { SidebarOverlays } from './SidebarOverlays';
import { SidebarRail } from './SidebarRail';
import { SidebarThreads } from './SidebarThreads';
import type { Meta } from './types';
import { useFloatingPanel } from './useFloatingPanel';
import { useSessionActions } from './useSessionActions';
import { useSidebarEndpoints, useModeRedirect } from './useSidebarEndpoints';
import { useSidebarHistory } from './useSidebarHistory';
import { useSidebarRename } from './useSidebarRename';
import { useSidebarResize } from './useSidebarResize';
import { useSidebarSearch } from './useSidebarSearch';
import { useSidebarSessions } from './useSidebarSessions';

interface SidebarProps {
  collapsed: boolean;
  /** 设置在内容区打开时，保留应用导航，隐藏并保活会话列表。 */
  panelHidden?: boolean;
  onToggle: () => void;
  /** projectId：新 Nomi 对话放进哪个项目（null = 不放进项目；不给 = 沿用当前对话的） */
  onNewChat: (opts?: { projectId?: string | null }) => void | Promise<void>;
  /** 打开分叉弹窗（新会话或其他端在弹窗里选） */
  onForkRequest?: (id: string) => void;
  /** 打开历史会话失败 / 有提示时 */
  onNotice?: (message: string) => void;
  /** 跳到设置的某个分区 / 标签：「按端」信息卡、「开始使用」清单 */
  onOpenSettings?: (section: SettingsSectionInput, tab?: SettingsTab) => void;
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
  panelHidden = false,
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
  // Nomi 对话没有 CLI 标签，行首的状态点只能从「正在回复的会话」里取（与 agent 的 running 一致）
  const busyConvos = useAiChatSelector(selectBusyConvos);
  const runningIds = useMemo(
    () => new Set((busyConvos ?? []).filter((id) => id !== '')),
    [busyConvos],
  );
  // 刚跑完一轮、还没点进去看过的 Nomi 会话：行首留一个绿点，点进会话就消
  const doneConvos = useAiChatSelector(selectDoneConvos);
  const doneIds = useMemo(
    () => new Set((doneConvos ?? []).filter((id) => id !== '')),
    [doneConvos],
  );
  const tabs = useHarnessTabs();
  const { isDev, isNormal } = useChatMode();
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
    pinnedProjects,
    toggleProjectPin,
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
    if (!ipc?.listConversations) {
      startupBrandIntro.taskDone('sidebar');
      return;
    }
    void ipc
      .listConversations()
      .then((l) => {
        const next = [...l].sort((a, b) => b.updatedAt - a.updatedAt);
        // 内容没变就保留旧引用：否则每次刷新都让依赖 list 的 memo 与所有行重算
        setList((prev) => (sameMetaList(prev, next) ? prev : next));
        setCurrent(ipc.currentConversationId?.());
      })
      .catch(() => undefined)
      .finally(() => startupBrandIntro.taskDone('sidebar'));
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
  const resize = useSidebarResize(!collapsed);
  // 会话面板收起时先放完收回动画再卸载
  const panelP = usePresence(!collapsed || float.floating, 220);
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
    const c: Record<ConversationBackend, number> = { nomi: 0, ...byCli(() => 0) };
    for (const x of navList) c[x.backend] = (c[x.backend] ?? 0) + 1;
    return c;
  }, [navList]);

  const startRename = useSidebarRename(collapsed, onToggle, highlightId, setRenamingId);

  const visible = useMemo(() => {
    if (view === 'by-endpoint') return navList.filter((x) => x.backend === endpointFilter);
    return navList;
  }, [navList, view, endpointFilter]);

  // 置顶不单独成组：置顶的会话排在所在项目（或「其他对话」、平铺列表）的最前面
  const ordered = useMemo(() => pinnedFirst(visible), [visible]);
  const wsGroups = useProjectGrouping(
    ordered,
    projects,
    tabById,
    groupByWorkspace,
    navList,
    pinnedProjects,
  );

  const {
    histBackends,
    tabsKey,
    history,
    openSessionKeys,
    historyItems,
    histScope,
    histScopeSupported,
    histItems,
    endpointActivity,
    railEndpoints,
    histVisible,
    histScanning,
  } = useSidebarHistory({
    isDev,
    list,
    bins,
    tabs,
    view,
    endpointFilter,
    endpointVisibility,
    endpointOrder,
    counts,
  });

  const {
    openingKey,
    openHistory: openHistoryRaw,
    deleteHistory,
    deleteTab,
  } = useSessionActions({
    onNotice,
    refresh,
    refreshHistory: history.refresh,
  });

  const {
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
  } = useSidebarSessions({
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
    chosenProject: ws.chosen ?? null,
    resetChosenProject: ws.reset,
    deleteTab,
    tabStatusOf: (tabId) => tabById.get(tabId)?.status,
    setCtx,
    setNewMenu,
    setHistMenu,
    setRenamingId,
  });

  // 别处请求打开会话（Agent 看板里正在回答的 Nomi 对话）
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === 'string' && id) void open(id);
    };
    window.addEventListener(OPEN_CONVERSATION_EVENT, on);
    return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, on);
  }, [open]);

  const listPeek = useSessionPeek(400);
  const projectPeek = useProjectPeek(220);
  const { onPeek: onSessionPeek, hide: hideSessionPeek } = listPeek;
  const { onPeek: onProjectPeek, hide: hideProjectPeek } = projectPeek;
  const handleSessionPeek = useCallback(
    (id: string, el: HTMLElement | null) => {
      if (el) hideProjectPeek();
      onSessionPeek(id, el);
    },
    [hideProjectPeek, onSessionPeek],
  );
  const handleProjectPeek = useCallback(
    (projectId: string, el: HTMLElement | null) => {
      if (el) hideSessionPeek();
      onProjectPeek(projectId, el);
    },
    [hideSessionPeek, onProjectPeek],
  );

  const handleNewClick = () => {
    hideProjectPeek();
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

  const cliMissing = (b: ConversationBackend) => b !== 'nomi' && !bins[b];

  const openHistory = useCallback(
    (h: Parameters<typeof openHistoryRaw>[0]) => {
      leaveRef.current?.();
      return openHistoryRaw(h);
    },
    [openHistoryRaw, leaveRef],
  );

  const { cardBackend, endpointRunning, endpointLastTab, pickEndpoint, endpointTip } =
    useSidebarEndpoints({
      tabs,
      navList,
      highlightId,
      endpointFilter,
      setEndpointFilter,
      setView,
      counts,
      tabById,
      histBackends,
      historyItems,
      cliMissing,
      open,
      createFor,
      onLeavePage,
    });

  useModeRedirect({ isDev, list, current, open, createFor });

  // ── 搜索：图标按钮 → 原位展开为搜索框；Mod+F 聚焦；Esc 清空 / 收起；150ms 防抖
  const {
    searchOpen,
    setSearchOpen,
    query,
    setQuery,
    inputRef,
    searching,
    searchIndex,
    results,
    shown,
    activeIdx,
    setActiveIdx,
    closeSearch,
    onSearchKey,
    canSearchMore,
  } = useSidebarSearch({
    isDev,
    view,
    endpointFilter,
    visible,
    tabById,
    ipc,
    histBackends,
    tabsKey,
    historyItems,
    openSessionKeys,
    histScope,
    histScopeSupported,
    open,
    openHistory,
  });

  const newLabel = t('ui.cli-monitor.new-conversation');

  const newBtn = (
    <NewChatButton
      label={newLabel}
      onClick={handleNewClick}
      hasMenu={isDev && view === 'all'}
      menuOpen={newMenu}
      menuP={newMenuP}
      menuRef={menuRef}
      newBtnRef={newBtnRef}
      newPopRef={newPopRef}
      bins={bins}
      project={ws}
      onPick={(b) => void createFor(b)}
      onPickPreset={(p) => void createFor(p.cli, undefined, p)}
    />
  );

  // 新建项目（「+」）：打开「创建项目」弹窗，建好后在这个项目里开一个会话（onSaved）
  const newProjectBtn = (
    <NewProjectButton
      onClick={() => {
        hideProjectPeek();
        setProjectDialog('new');
      }}
    />
  );
  // 「项目」标题右侧：整理「…」+ 新建项目（「+」），悬停标题时才显示；不分组时（「对话」）只有整理。
  // 新对话在顶行（不放进任何项目）
  const listOpen = !collapsedWorkspaces.includes(SECTION_WORKSPACES);
  const organize = <OrganizeMenu grouped={groupByWorkspace} onChange={setGroupByWorkspace} />;
  const listActions = wsGroups.grouped ? (
    <>
      {organize}
      {newProjectBtn}
    </>
  ) : (
    organize
  );

  // react-window 按浅比较 rowProps 决定是否重渲染行：对象本身也要稳定
  const rowProps = useMemo(
    () => ({
      items: ordered,
      current: highlightId,
      tabById,
      runningIds,
      doneIds,
      open,
      onCtx,
      renamingId,
      onRename: commitRename,
      onPinToggle: togglePin,
      onMore: openMore,
      onPeek: handleSessionPeek,
      showIcon: isDev && view === 'all',
    }),
    [
      ordered,
      highlightId,
      tabById,
      runningIds,
      doneIds,
      open,
      onCtx,
      renamingId,
      commitRename,
      togglePin,
      openMore,
      handleSessionPeek,
      isDev,
      view,
    ],
  );
  // 收起退场动画（panelP.closing）期间不要立即把外层锁成 52px，否则右侧卡片会 0ms 硬跳盖住退场抽屉
  const railOnly = !panelP.value || float.floating || panelHidden;
  return (
    <aside
      className={`${styles.sidebar} ${railOnly ? styles.collapsed : ''}`}
      data-testid="chat-sidebar"
      data-panel={collapsed || panelHidden ? undefined : 'open'} // 展开：与右边对话卡片拼成一张（App.css）
      onMouseEnter={!panelHidden && float.floating ? float.cancelHide : undefined}
      onMouseLeave={!panelHidden && collapsed ? float.scheduleHide : undefined}
    >
      {!panelHidden && resize.splitter}
      <SidebarRail
        panelHidden={panelHidden}
        collapsed={collapsed}
        pageOpen={pageOpen}
        topNav={topNav}
        footer={footer}
        showEndpoints={isDev}
        view={view}
        endpointFilter={endpointFilter}
        railEndpoints={railEndpoints}
        allEndpoints={orderEndpoints(CONVERSATION_BACKENDS, endpointActivity, endpointOrder)}
        endpointActivity={endpointActivity}
        endpointVisibility={endpointVisibility}
        endpointOrder={endpointOrder}
        cliMissing={cliMissing}
        tipOf={endpointTip}
        onShowFloat={float.show}
        onLeavePage={() => leaveRef.current?.()}
        onAll={() => setView('all')}
        onPick={pickEndpoint}
        onReorder={setEndpointOrder}
        onVisibility={(b, v) => {
          setEndpointVisibility(b, v);
          // 隐藏了正在看的端点：回到「全部」，免得筛选停在看不见的端点上
          if (v === 'hide' && b === endpointFilter && view === 'by-endpoint') setView('all');
        }}
      />
      {panelP.value && (
        <div
          className={`${styles.panel} ${float.floating ? styles.panelFloating : ''}`}
          data-testid="sidebar-panel"
          hidden={panelHidden}
          data-floating={float.floating || undefined}
          data-closing={panelP.closing || undefined}
          aria-hidden={panelP.closing || undefined}
        >
          {/* 顶行：新对话在左，搜索在右；整理与新建项目在「项目」标题右侧 */}
          <div className={styles.top}>
            {newBtn}
            <button
              type="button"
              className={styles.headBtn}
              onClick={() => setSearchOpen(true)}
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
            onScroll={() => {
              hideSessionPeek();
              hideProjectPeek();
            }}
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
            <SidebarThreads
              grouped={wsGroups.grouped}
              wsGroups={wsGroups}
              collapsedWorkspaces={collapsedWorkspaces}
              onToggleCollapsed={setWorkspaceCollapsed}
              onNewIn={(g, b, p) =>
                void createFor(
                  b ?? projectBackend(g, isNormal, view, endpointFilter),
                  g.project.id,
                  p,
                )
              }
              onEdit={(g) => {
                hideProjectPeek();
                setProjectDialog(g.project);
              }}
              activeId={rowActiveId}
              rows={rowProps}
              headerActions={listActions}
              isDev={isDev}
              view={view}
              bins={bins}
              onProjectPeek={handleProjectPeek}
              onHideProjectPeek={hideProjectPeek}
              listLabel={t('ui.chat-settings.chats')}
              listOpen={listOpen}
              onToggleList={() => setWorkspaceCollapsed(SECTION_WORKSPACES, listOpen)}
              ordered={ordered}
              tabById={tabById}
              runningIds={runningIds}
              doneIds={doneIds}
              renamingId={renamingId}
              showIcon={isDev && view === 'all'}
              histVisible={histVisible}
              histItems={histItems}
              histScanning={histScanning}
              openingKey={openingKey}
              onOpenHistory={(h) => void openHistory(h)}
              onHistMenu={(h, x, y, anchor) => {
                setNewMenu(false);
                setCtx(null);
                // 再点同一个「更多」按钮：关掉菜单
                setHistMenu((cur) =>
                  anchor && cur?.anchor === anchor ? null : { h, x, y, anchor },
                );
              }}
              histScope={histScope}
              histScopeSupported={histScopeSupported}
              hasMore={histScopeSupported && history.hasMore(histScope)}
              historyLoading={history.loading}
              onLoadMore={() => history.loadMore(histScope)}
              onRefreshHistory={history.refresh}
            />
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

      <SidebarOverlays
        list={list}
        visible={visible}
        navList={navList}
        tabById={tabById}
        runningIds={runningIds}
        doneIds={doneIds}
        onForkRequest={onForkRequest}
        startRename={startRename}
        togglePin={togglePin}
        closeItem={(m) => void closeItem(m)}
        archiveItem={(id) => void archiveItem(id)}
        removeItem={(id) => void removeItem(id)}
        onCtx={onCtx}
        ctxP={ctxP}
        setCtx={setCtx}
        listPeek={listPeek}
        projectPeek={projectPeek}
        projectGroups={wsGroups.groups}
        onToggleProjectPin={toggleProjectPin}
        onEditProject={(g) => {
          hideProjectPeek();
          setProjectDialog(g.project);
        }}
        commitRename={commitRename}
        projectDialog={projectDialog}
        setProjectDialog={setProjectDialog}
        onProjectSaved={(p) =>
          void createFor(
            isNormal
              ? 'nomi'
              : view === 'by-endpoint'
                ? endpointFilter
                : cliMissing(cardBackend)
                  ? 'nomi'
                  : cardBackend,
            p.id,
          )
        }
        searchOpen={searchOpen}
        query={query}
        setQuery={setQuery}
        inputRef={inputRef}
        onSearchKey={onSearchKey}
        closeSearch={closeSearch}
        searching={searching}
        shown={shown}
        results={results}
        activeIdx={activeIdx}
        setActiveIdx={setActiveIdx}
        searchIndex={searchIndex}
        canSearchMore={canSearchMore}
        openingKey={openingKey}
        open={(id) => void open(id)}
        openHistory={(h) => void openHistory(h)}
        newLabel={newLabel}
        newHint={formatCombo(bindings.newChat)}
        onNew={handleNewClick}
        onOpenTask={onOpenTask}
        onOpenAsset={onOpenAsset}
        histMenuP={histMenuP}
        setHistMenu={setHistMenu}
        deleteHistory={(h) => void deleteHistory(h)}
      />
    </aside>
  );
};

/** memo：App 每次渲染（流式输出、标签进度）不再连带重渲染整个侧栏 */
export const Sidebar = React.memo(SidebarImpl);
