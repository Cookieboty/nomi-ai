import { t, Icon } from '@nomi-ai/ui';
import { RefreshCw, X, PanelLeft, SquarePen } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { List } from 'react-window';

import { useAiChat } from '../../contexts/AiChatContext';
import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import { useCliHistory } from '../../hooks/useCliHistory';
import { useCliTabSync } from '../../hooks/useCliTabSync';
import { useConversationListView } from '../../hooks/useConversationListView';
import { MAX_RESULTS, useHistorySearchIndex } from '../../hooks/useHistorySearchIndex';
import { useNewWorkspace } from '../../hooks/useNewWorkspace';
import { MAIN_TAB_ID, harnessClient, type HarnessTabMeta } from '../../services/harnessClient';
import {
  HISTORY_BACKENDS,
  historyClient,
  type HistoryBackend,
  type HistorySession,
} from '../../services/historyClient';
import { SEARCH_CHATS_EVENT, formatCombo, useShortcutBindings } from '../../services/shortcuts';
import type { ConversationBackend } from '../../types/chat';
import { CONVERSATION_BACKENDS } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import { rankItems } from '../../utils/fuzzy';
import { ConversationMenu } from '../ConversationMenu';
import { EndpointIcon } from '../EndpointIcon';
import { EndpointInfoCard } from '../EndpointInfo';
import { NewChatMenu } from '../NewChatMenu';

import styles from './index.module.css';
import {
  firstUserMessageCache,
  Highlight,
  fieldsOf,
  useDebounced,
  SearchIcon,
  type SearchEntry,
} from './searchSupport';
import { rel, liveOf, RowActions, ThreadItem, VirtualRow } from './SidebarRows';
import type { Meta } from './types';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  onForkRequest?: (id: string, mode: 'same' | 'cross') => void;
  /** 打开历史会话失败 / 有提示时 */
  onNotice?: (message: string) => void;
  /** 「按端」信息卡里的跳转：设置 → 编程助手 / 用量与费用 */
  onOpenSettings?: (section: 'coding' | 'usage') => void;
}

/** 侧栏：全部 / 按端 + 端点徽标；点击按后端路由到主对话或 CLI 标签 */
export const Sidebar: React.FC<SidebarProps> = ({
  collapsed,
  onToggle,
  onNewChat,
  onForkRequest,
  onNotice,
  onOpenSettings,
}) => {
  const { state, actions } = useAiChat();
  const ipc = state.ipcClient;
  const tabs = useHarnessTabs();
  const { isDev, isNormal, setMode } = useChatMode();
  const {
    view: storedView,
    setView,
    endpointFilter,
    setEndpointFilter,
  } = useConversationListView();
  // 普通模式只有 Nomi：视图固定为「全部」，但不改动已保存的选择，切回开发模式即恢复
  const view = isNormal ? 'all' : storedView;
  const bindings = useShortcutBindings();
  const [list, setList] = useState<Meta[]>([]);
  const [current, setCurrent] = useState<string | undefined>();
  const [bins, setBins] = useState<Record<string, string | null>>({});
  const [newMenu, setNewMenu] = useState(false);
  const [ctx, setCtx] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // 行内删除的二次确认（只对 Nomi 对话；CLI 标签是「关闭」，运行中才确认）
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [histMenu, setHistMenu] = useState<{ h: HistorySession; x: number; y: number } | null>(
    null,
  );
  const ws = useNewWorkspace();
  const menuRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    if (!ipc?.listConversations) return;
    void ipc
      .listConversations()
      .then((l) => {
        setList([...l].sort((a, b) => b.updatedAt - a.updatedAt));
        setCurrent(ipc.currentConversationId?.());
      })
      .catch(() => undefined);
  }, [ipc]);

  useCliTabSync(refresh);
  // loading 变化时也刷新：首个会话在第一条消息保存时才创建，发送结束后需要让它出现在列表里
  useEffect(refresh, [refresh, state.messages.length, state.isLoading, tabs.state]);

  useEffect(() => {
    if (!harnessClient.available()) return;
    void harnessClient
      .state()
      .then((s) => setBins(s.bins))
      .catch(() => undefined);
  }, [isDev]);

  useEffect(() => {
    if (!newMenu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && menuRef.current?.contains(e.target as Node)) return;
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
    for (const x of tabs.state?.tabs ?? []) m.set(x.id, x);
    return m;
  }, [tabs.state]);

  // 普通模式：侧栏只列 Nomi 会话（CLI 标签仍在后台运行，切回开发模式即可看到）
  const navList = useMemo(
    () => (isNormal ? list.filter((x) => x.backend === 'nomi') : list),
    [list, isNormal],
  );

  const counts = useMemo(() => {
    const c: Record<ConversationBackend, number> = {
      nomi: 0,
      claude: 0,
      codex: 0,
      dsh: 0,
      grok: 0,
    };
    for (const x of navList) c[x.backend] = (c[x.backend] ?? 0) + 1;
    return c;
  }, [navList]);

  // 当前端的运行中 / 排队中标签数与最近一次标签活动（信息卡用）
  const { endpointRunning, endpointLastTab } = useMemo(() => {
    let running = 0;
    let last: number | null = null;
    for (const x of tabs.state?.tabs ?? []) {
      if (x.backend !== endpointFilter) continue;
      if (x.status === 'running' || x.status === 'queued') running++;
      if (last == null || x.updatedAt > last) last = x.updatedAt;
    }
    return { endpointRunning: running, endpointLastTab: last };
  }, [tabs.state, endpointFilter]);

  const visible = useMemo(() => {
    if (view === 'by-endpoint') return navList.filter((x) => x.backend === endpointFilter);
    return navList;
  }, [navList, view, endpointFilter]);

  const open = useCallback(
    async (id: string) => {
      if (!ipc) return;
      const meta =
        list.find((x) => x.id === id) ?? (await ipc.listConversations()).find((x) => x.id === id);
      if (!meta) return;
      setCtx(null);

      if (meta.backend !== 'nomi' && meta.tabId) {
        if (!isDev) setMode('dev');
        await tabs.activate(meta.tabId);
        await ipc.switchConversation(id).catch(() => undefined);
        refresh();
        return;
      }

      if (tabs.available) await tabs.activate(MAIN_TAB_ID);
      if (harnessClient.available()) {
        await harnessClient.setBackend('nomi').catch(() => undefined);
      }
      if (id !== current) {
        await ipc.switchConversation(id);
        await actions.loadChatHistory();
      }
      refresh();
    },
    [ipc, list, isDev, setMode, tabs, refresh, current, actions],
  );

  const createFor = async (backend: ConversationBackend) => {
    setNewMenu(false);
    if (backend === 'nomi') {
      if (tabs.available) await tabs.activate(MAIN_TAB_ID);
      if (harnessClient.available()) await harnessClient.setBackend('nomi').catch(() => undefined);
      onNewChat();
      const store = ipc.conversationStore?.();
      if (store) {
        const id = store.ensureCurrent();
        const m = store.get(id);
        if (m && m.backend !== 'nomi') store.updateMeta(id, { backend: 'nomi' });
      }
      refresh();
      return;
    }
    if (!isDev) setMode('dev');
    if (!tabs.available) return;
    await tabs.create(backend, ws.chosen);
    refresh();
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
    setConfirmId(null);
    if (meta.tabId) {
      const st = tabById.get(meta.tabId)?.status;
      if (
        (st === 'running' || st === 'queued') &&
        !window.confirm(t('该标签仍在运行，关闭会中止它。确定关闭？'))
      )
        return;
      await tabs.close(meta.tabId);
    } else {
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
      const meta = list.find((x) => x.id === id);
      if (!meta || meta.name === name) return;
      if (meta.tabId) void tabs.rename(meta.tabId, name).catch(() => undefined);
      else ipc.conversationStore?.()?.updateMeta(id, { name });
      refresh();
    },
    [ipc, list, tabs, refresh],
  );

  const requestDelete = (id: string) => {
    const meta = list.find((x) => x.id === id);
    if (!meta) return;
    // CLI 标签：关闭标签（可从历史重新打开），运行中沿用关闭确认；Nomi 对话：永久删除，先二次确认
    if (meta.tabId || confirmId === id) void removeItem(id);
    else setConfirmId(id);
  };
  const cancelDelete = useCallback(() => setConfirmId(null), []);
  useEffect(() => {
    if (!confirmId) return;
    const timer = window.setTimeout(() => setConfirmId(null), 5000);
    return () => window.clearTimeout(timer);
  }, [confirmId]);

  /** 行内「更多」：与右键共用同一个 ConversationMenu，只是锚在按钮下方 */
  const openMore = useCallback((id: string, a: DOMRect) => {
    setNewMenu(false);
    setHistMenu(null);
    setCtx({ id, x: a.right - 184, y: a.bottom + 2 });
  }, []);

  const onCtx = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    setNewMenu(false);
    setCtx({ id, x: e.clientX, y: e.clientY });
  };

  const cliMissing = (b: ConversationBackend) => b !== 'nomi' && !bins[b];

  // 开发模式：磁盘上的 CLI 历史会话（每端 50 条一页）
  const histBackends = useMemo(() => HISTORY_BACKENDS.filter((b) => Boolean(bins[b])), [bins]);
  const tabsKey = (tabs.state?.tabs ?? []).map((x) => `${x.id}:${x.cliSessionId ?? ''}`).join('|');
  const history = useCliHistory(isDev, histBackends, tabsKey);
  const histScope: HistoryBackend | undefined =
    view === 'by-endpoint' && endpointFilter !== 'nomi'
      ? (endpointFilter as HistoryBackend)
      : undefined;
  // 磁盘历史扫描仅支持 claude/codex/dsh（HISTORY_BACKENDS）；grok 暂无转录扫描，
  // 不能把 'grok' 传给 history.items —— 其状态表没有该键会读到 undefined.items 而崩溃
  const histScopeSupported =
    histScope === undefined || (HISTORY_BACKENDS as readonly string[]).includes(histScope);
  const histItems: HistorySession[] =
    !histScopeSupported || (view === 'by-endpoint' && endpointFilter === 'nomi')
      ? []
      : history.items(histScope);
  const [openingKey, setOpeningKey] = useState<string | null>(null);

  const openHistory = async (h: HistorySession) => {
    if (openingKey) return;
    setOpeningKey(h.key);
    try {
      const r = await historyClient.open(h.backend, h.sessionId);
      if (!r.ok) onNotice?.(r.error || t('打开历史会话失败'));
      else if (r.notice) onNotice?.(r.notice);
    } catch (e) {
      onNotice?.(e instanceof Error ? e.message : String(e));
    } finally {
      setOpeningKey(null);
      history.refresh();
    }
  };

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
  const searching = !collapsed && searchOpen && debounced.trim() !== '';
  const searchIndex = useHistorySearchIndex(isDev && searching, histBackends, tabsKey);

  useEffect(() => {
    const onEvent = () => {
      setSearchOpen(true);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    };
    window.addEventListener(SEARCH_CHATS_EVENT, onEvent);
    return () => window.removeEventListener(SEARCH_CHATS_EVENT, onEvent);
  }, []);
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
        const msgs = ipc?.conversationStore?.()?.getMessages(m.id) ?? [];
        text = (
          msgs.find((x: { role: string; content?: string }) => x.role === 'user')?.content ?? ''
        ).slice(0, 300);
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
        title: m.name ? t(m.name) : t('新对话'),
        first: firstUserMessage(m),
        cwd: (m.tabId ? tabById.get(m.tabId)?.cwd : '') ?? '',
      });
    }
    if (isDev && histScopeSupported && !(view === 'by-endpoint' && endpointFilter === 'nomi')) {
      // 已加载的分页 + 搜索索引合并，同一会话（backend:sessionId）只保留一条
      for (const h of [...history.items(histScope), ...searchIndex.items]) {
        if (histScope && h.backend !== histScope) continue;
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
    history,
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
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
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
  const newTip = [t('新对话'), formatCombo(bindings.newChat)].join(' ');
  const searchTip = [t('搜索对话'), formatCombo(bindings.searchChats)].join(' ');
  const showHistory = isDev;

  const newBtn = (
    <div className={styles.newWrap} ref={menuRef}>
      <button
        className={styles.iconBtn}
        onClick={handleNewClick}
        title={newTip}
        aria-label={t('新对话')}
        aria-haspopup={isDev && view === 'all' ? 'menu' : undefined}
        aria-expanded={isDev && view === 'all' ? newMenu : undefined}
        data-testid="new-chat"
      >
        <Icon icon={SquarePen} />
      </button>
      {newMenu && !collapsed && (
        <NewChatMenu
          className={styles.newMenu}
          backends={CONVERSATION_BACKENDS}
          bins={bins}
          strictBins
          workspace={ws}
          onPick={(b) => void createFor(b)}
        />
      )}
    </div>
  );

  return (
    <aside
      className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}
      data-testid="chat-sidebar"
    >
      <div className={styles.top}>
        <button
          className={styles.iconBtn}
          onClick={onToggle}
          title={collapsed ? t('展开侧边栏 (⌘/Ctrl+B)') : t('收起侧边栏 (⌘/Ctrl+B)')}
          aria-label={collapsed ? t('展开侧边栏') : t('收起侧边栏')}
          data-testid="sidebar-toggle"
        >
          <Icon icon={PanelLeft} />
        </button>
        {!collapsed && searchOpen && (
          <div className={styles.searchBox} role="search" data-testid="sidebar-search">
            <span className={styles.searchGlyph} aria-hidden>
              <SearchIcon />
            </span>
            <input
              ref={inputRef}
              className={styles.searchInput}
              type="text"
              role="searchbox"
              value={query}
              placeholder={t('搜索会话…')}
              aria-label={t('搜索对话')}
              aria-controls="sidebar-search-results"
              aria-activedescendant={
                searching && shown.length
                  ? `sb-result-${Math.min(activeIdx, shown.length - 1)}`
                  : undefined
              }
              autoComplete="off"
              spellCheck={false}
              data-testid="sidebar-search-input"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
            />
            <button
              type="button"
              className={styles.searchClear}
              title={query ? t('清除搜索') : t('关闭搜索')}
              aria-label={query ? t('清除搜索') : t('关闭搜索')}
              data-testid="sidebar-search-clear"
              onClick={() => (query ? (setQuery(''), inputRef.current?.focus()) : closeSearch())}
            >
              <Icon icon={X} size={14} />
            </button>
          </div>
        )}
        {!collapsed && !searchOpen && (
          <>
            <span className={styles.brandWrap}>
              <EndpointIcon backend="nomi" size={20} decorative />
              <span className={styles.brand}>Nomi</span>
            </span>
            <span className={styles.spacer} />
            <button
              className={styles.iconBtn}
              onClick={() => setSearchOpen(true)}
              title={searchTip}
              aria-label={t('搜索对话')}
              data-testid="sidebar-search-toggle"
            >
              <SearchIcon />
            </button>
            {newBtn}
          </>
        )}
      </div>
      {collapsed && <div className={styles.collapsedNew}>{newBtn}</div>}

      {!collapsed && !searching && (
        <div className={styles.listHeader}>
          <div className={styles.listHeadRow}>
            <span className={styles.sectionTitleInline}>
              {view === 'by-endpoint' ? ENDPOINT_FULL[endpointFilter]() : t('对话')}
            </span>
            {isDev && (
              <div className={styles.seg} role="group" aria-label={t('对话列表视图')}>
                <button
                  type="button"
                  className={styles.segBtn}
                  aria-pressed={view === 'all'}
                  data-testid="list-view-all"
                  onClick={() => setView('all')}
                >
                  {t('全部')}
                </button>
                <button
                  type="button"
                  className={styles.segBtn}
                  aria-pressed={view === 'by-endpoint'}
                  data-testid="list-view-by-endpoint"
                  onClick={() => setView('by-endpoint')}
                >
                  {t('按端')}
                </button>
              </div>
            )}
          </div>
          {isDev && view === 'by-endpoint' && (
            <div className={styles.epRow} role="group" aria-label={t('按端点筛选')}>
              {CONVERSATION_BACKENDS.map((b) => (
                <button
                  key={b}
                  type="button"
                  className={styles.epChip}
                  aria-pressed={endpointFilter === b}
                  disabled={cliMissing(b)}
                  data-testid={`endpoint-filter-${b}`}
                  onClick={() => setEndpointFilter(b)}
                  title={ENDPOINT_FULL[b]()}
                >
                  <EndpointIcon backend={b} size={14} decorative />
                  <span>{ENDPOINT_FULL[b]()}</span>
                  <span className={styles.epCount}>{counts[b]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!collapsed && (
        <nav className={styles.threads} aria-label={t('历史对话')} data-testid="conversation-list">
          {searching && (
            <div
              id="sidebar-search-results"
              role="listbox"
              aria-label={t('搜索结果')}
              data-testid="sidebar-search-results"
            >
              <div
                className={styles.sectionTitle}
                aria-live="polite"
                data-testid="sidebar-search-count"
              >
                {t('搜索结果 {0}', results.length)}
                {searchIndex.loading ? ['', t('正在索引历史会话…')].join(' · ') : ''}
              </div>
              {shown.map(({ item, ranges }, i) => {
                const selected = i === Math.min(activeIdx, shown.length - 1);
                if (item.kind === 'conv') {
                  const c = item.meta;
                  return (
                    <button
                      key={item.id}
                      id={`sb-result-${i}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`${styles.thread} ${styles.resultRow} ${selected ? styles.resultActive : ''}`}
                      data-testid="search-result"
                      data-kind="conv"
                      data-backend={c.backend}
                      data-conversation-id={c.id}
                      title={[item.title, item.cwd].filter(Boolean).join('\n')}
                      onMouseMove={() => setActiveIdx(i)}
                      onClick={() => void open(c.id)}
                      onContextMenu={(e) => onCtx(c.id, e)}
                    >
                      <span
                        className={styles.dot}
                        data-live={liveOf(c.tabId ? tabById.get(c.tabId) : undefined) || undefined}
                        aria-hidden
                      />
                      <EndpointIcon backend={c.backend} size={14} decorative />
                      <span className={styles.threadName}>
                        <Highlight text={item.title} ranges={ranges} />
                      </span>
                      <span className={styles.threadTime}>{rel(c.updatedAt)}</span>
                    </button>
                  );
                }
                const h = item.h;
                return (
                  <button
                    key={item.id}
                    id={`sb-result-${i}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`${styles.thread} ${styles.resultRow} ${selected ? styles.resultActive : ''} ${styles.histRow}`}
                    data-testid="search-result"
                    data-kind="hist"
                    data-backend={h.backend}
                    data-session-id={h.sessionId}
                    data-cwd-missing={h.cwdMissing || undefined}
                    aria-busy={openingKey === h.key}
                    title={[h.title, h.cwd].filter(Boolean).join('\n')}
                    onMouseMove={() => setActiveIdx(i)}
                    onClick={() => void openHistory(h)}
                  >
                    <span className={styles.dot} aria-hidden />
                    <EndpointIcon backend={h.backend} size={14} decorative />
                    <span className={styles.threadName}>
                      <Highlight text={h.title} ranges={ranges} />
                    </span>
                    <span className={styles.threadTime}>{rel(h.updatedAt)}</span>
                  </button>
                );
              })}
              {results.length > MAX_RESULTS && (
                <div className={styles.empty} data-testid="sidebar-search-capped">
                  {t('只显示前 {0} 条，请输入更多关键词', MAX_RESULTS)}
                </div>
              )}
              {results.length === 0 && (
                <div className={styles.empty} data-testid="sidebar-search-empty">
                  {searchIndex.loading ? t('正在搜索…') : t('没有匹配的会话')}
                </div>
              )}
              {canSearchMore && (
                <button
                  type="button"
                  className={styles.histMore}
                  onClick={searchIndex.more}
                  disabled={searchIndex.loading}
                  data-testid="sidebar-search-more"
                >
                  {searchIndex.loading ? t('加载中…') : t('搜索更早的历史')}
                </button>
              )}
            </div>
          )}
          {!searching && visible.length === 0 && (
            <div className={styles.empty}>{t('还没有历史对话')}</div>
          )}
          {!searching &&
            visible.length > 0 &&
            visible.length <= 100 &&
            visible.map((c) => (
              <ThreadItem
                key={c.id}
                c={c}
                active={c.id === current}
                tab={c.tabId ? tabById.get(c.tabId) : undefined}
                onOpen={open}
                onCtx={onCtx}
                renaming={renamingId === c.id}
                onRename={commitRename}
                confirming={confirmId === c.id}
                onRenameStart={setRenamingId}
                onDeleteRequest={requestDelete}
                onDeleteCancel={cancelDelete}
                onMore={openMore}
              />
            ))}
          {!searching && visible.length > 100 && (
            <div style={{ height: '100%', minHeight: 320 }} data-testid="conversation-list-virtual">
              <List
                rowCount={visible.length}
                rowHeight={52}
                rowComponent={VirtualRow}
                rowProps={{
                  items: visible,
                  current,
                  tabById,
                  open,
                  onCtx,
                  renamingId,
                  onRename: commitRename,
                  confirmId,
                  onRenameStart: setRenamingId,
                  onDeleteRequest: requestDelete,
                  onDeleteCancel: cancelDelete,
                  onMore: openMore,
                }}
                style={{ height: '100%', width: '100%' }}
              />
            </div>
          )}
          {!searching && showHistory && history.available && histBackends.length > 0 && (
            <div className={styles.histSection} data-testid="cli-history">
              <div className={styles.histHead}>
                <span className={styles.sectionTitle}>{t('编程助手历史会话')}</span>
                <button
                  type="button"
                  className={styles.histRefresh}
                  onClick={history.refresh}
                  disabled={history.loading}
                  title={t('刷新历史会话')}
                  aria-label={t('刷新历史会话')}
                  data-testid="cli-history-refresh"
                >
                  <Icon icon={RefreshCw} size={14} />
                </button>
              </div>
              {histItems.length === 0 &&
                (!histScopeSupported || (history.loaded && !history.loading)) && (
                  <div className={styles.empty} data-testid="cli-history-empty">
                    {t('没有找到本机的历史会话')}
                  </div>
                )}
              {histScopeSupported &&
                histItems.length === 0 &&
                history.loading &&
                !history.loaded && <div className={styles.empty}>{t('正在扫描历史会话…')}</div>}
              {histItems.map((h) => (
                <div
                  key={h.key}
                  className={`${styles.row} ${styles.histRow}`}
                  data-testid="history-session-row"
                >
                  <button
                    type="button"
                    className={styles.thread}
                    data-testid="history-session-item"
                    data-backend={h.backend}
                    data-session-id={h.sessionId}
                    data-cwd-missing={h.cwdMissing || undefined}
                    aria-busy={openingKey === h.key}
                    title={[h.title, h.cwd, h.cwdMissing ? t('原目录已不存在') : '']
                      .filter(Boolean)
                      .join('\n')}
                    onClick={() => void openHistory(h)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setNewMenu(false);
                      setCtx(null);
                      setHistMenu({ h, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span className={styles.dot} aria-hidden />
                    <EndpointIcon backend={h.backend} size={14} />
                    <span className={styles.threadName}>{h.title}</span>
                    <span className={styles.threadTime}>{rel(h.updatedAt)}</span>
                  </button>
                  {/* 磁盘历史是只读的：没有重命名 / 删除，「更多」里只有「在标签中打开」 */}
                  <RowActions
                    kind="hist"
                    onMore={(a) => {
                      setCtx(null);
                      setHistMenu({ h, x: a.right - 184, y: a.bottom + 2 });
                    }}
                  />
                </div>
              ))}
              {histScopeSupported && history.hasMore(histScope) && (
                <button
                  type="button"
                  className={styles.histMore}
                  onClick={() => history.loadMore(histScope)}
                  disabled={history.loading}
                  data-testid="cli-history-more"
                >
                  {history.loading ? t('加载中…') : t('加载更多')}
                </button>
              )}
            </div>
          )}
        </nav>
      )}

      {/* 「按端」视图：选中某端后，左下角固定一张该端的信息卡（点击打开详情抽屉） */}
      {!collapsed && !searching && isDev && view === 'by-endpoint' && (
        <EndpointInfoCard
          backend={endpointFilter}
          running={endpointRunning}
          lastTabActivity={endpointLastTab}
          bin={
            endpointFilter === 'nomi'
              ? undefined
              : (bins[endpointFilter] ?? (endpointFilter in bins ? null : undefined))
          }
          onOpenSettings={onOpenSettings}
        />
      )}

      {ctx &&
        (() => {
          const meta = list.find((x) => x.id === ctx.id);
          return (
            <ConversationMenu
              x={ctx.x}
              y={ctx.y}
              isTab={Boolean(meta?.tabId)}
              onDismiss={() => setCtx(null)}
              onRename={() => setRenamingId(ctx.id)}
              onFork={() => onForkRequest?.(ctx.id, 'same')}
              // 跨端分叉只在开发模式提供；普通模式只有「分叉为新对话」（同端 Nomi）
              onForkCross={isDev ? () => onForkRequest?.(ctx.id, 'cross') : undefined}
              onClose={meta?.tabId ? () => void removeItem(ctx.id) : undefined}
              onDelete={meta?.tabId ? undefined : () => void removeItem(ctx.id)}
            />
          );
        })()}

      {histMenu && (
        <ConversationMenu
          x={histMenu.x}
          y={histMenu.y}
          isTab={false}
          onDismiss={() => setHistMenu(null)}
          onOpen={() => void openHistory(histMenu.h)}
        />
      )}
    </aside>
  );
};
