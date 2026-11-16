import { t } from '@nomi-ai/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MAX_RESULTS, useHistorySearchIndex } from '../../hooks/useHistorySearchIndex';
import type { ConversationListView } from '../../services/chatPrefs';
import type { HarnessTabMeta } from '../../services/harnessClient';
import type { HistoryBackend, HistorySession } from '../../services/historyClient';
import type { ConversationBackend } from '../../types/chat';
import { rankItems } from '../../utils/fuzzy';
import { isImeComposing } from '../../utils/keyboard';

import { firstUserMessageCache, fieldsOf, useDebounced, type SearchEntry } from './searchSupport';
import type { Meta } from './types';
import { useSidebarSearchShortcut } from './useSidebarRename';

interface SidebarSearchOptions {
  isDev: boolean;
  view: ConversationListView;
  endpointFilter: ConversationBackend;
  visible: Meta[];
  tabById: Map<string, HarnessTabMeta>;
  ipc:
    | { conversationStore?: () => { firstUserPreview?: (id: string) => string } | undefined }
    | null
    | undefined;
  histBackends: readonly HistoryBackend[];
  tabsKey: string;
  historyItems: (backend?: HistoryBackend) => HistorySession[];
  openSessionKeys: ReadonlySet<string>;
  histScope: HistoryBackend | undefined;
  histScopeSupported: boolean;
  open: (id: string) => void;
  openHistory: (h: HistorySession) => void;
}

/** 侧栏搜索：展开状态、防抖查询、结果排序、键盘选择与「打开」 */
export function useSidebarSearch({
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
}: SidebarSearchOptions) {
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

  const closeSearch = () => {
    setQuery('');
    setSearchOpen(false);
  };
  const openEntry = (e: SearchEntry | undefined) => {
    if (!e) return;
    closeSearch();
    if (e.kind === 'conv') void open(e.id);
    else void openHistory(e.h);
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

  return {
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
    openEntry,
    closeSearch,
    onSearchKey,
    canSearchMore,
  };
}
