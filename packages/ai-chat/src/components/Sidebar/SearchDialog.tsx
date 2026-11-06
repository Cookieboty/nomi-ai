/**
 * 侧栏搜索（Codex 式）：点放大镜或 Mod+F 弹出居中的搜索窗。
 * 没输入时是「快捷操作」（新对话）+「最近对话」；输入后是对话与本机历史的模糊搜索结果。
 * ↑↓ 选择、Enter 打开；Esc 先清空再关闭，点窗外也关闭。
 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import { ListChecks, MessageSquare, SquarePen, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { hostAssetUrl } from '../../services/api';
import type { HarnessTabMeta } from '../../services/harnessClient';
import type { HistorySession } from '../../services/historyClient';
import { rankItems, type Ranked } from '../../utils/fuzzy';
import { useAssets } from '../AssetLibrary';
import { sourceName, type AssetItem } from '../AssetLibrary/ImageViewer';
import { EndpointIcon } from '../EndpointIcon';
import { useTasks } from '../Tasks';

import styles from './index.module.css';
import { Highlight, SearchIcon, type SearchEntry } from './searchSupport';
import { liveOf, rel } from './SidebarRows';
import type { Meta } from './types';

type SearchTab = 'all' | 'chats' | 'tasks' | 'assets';

const tabLabel = (id: SearchTab): string =>
  id === 'all'
    ? t('ui.providers-schedule.all')
    : id === 'chats'
      ? t('ui.chat-settings.chats')
      : id === 'tasks'
        ? t('ui.providers-schedule.tasks')
        : t('ui.media.asset-library');

/** 素材的标题：生成时的提示词，没有就用文件名 */
const assetTitle = (x: AssetItem) => x.prompt?.trim() || baseName(x.file);

const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

export const SearchDialog: React.FC<{
  query: string;
  onQuery: (q: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onClose: () => void;
  /** 有输入（防抖后）：显示搜索结果 */
  searching: boolean;
  shown: ReadonlyArray<Ranked<SearchEntry>>;
  total: number;
  max: number;
  activeIdx: number;
  onActive: (i: number) => void;
  indexing: boolean;
  canSearchMore: boolean;
  onSearchMore: () => void;
  openingKey: string | null | undefined;
  tabById: Map<string, HarnessTabMeta>;
  onOpenConv: (id: string) => void;
  onOpenHist: (h: HistorySession) => void;
  onCtx: (id: string, e: React.MouseEvent) => void;
  /** 没输入时列出的最近对话 */
  recent: readonly Meta[];
  newLabel: string;
  newHint: string;
  onNew: () => void;
  /** 打开某个任务 / 素材（没有时不显示对应的标签页） */
  onOpenTask?: (id: string) => void;
  onOpenAsset?: (file: string) => void;
}> = (p) => {
  useLocale();
  const [tab, setTab] = useState<SearchTab>('all');
  // 只在搜索窗开着时读任务与素材（各自的页面也用同一份接口）
  const { data } = useTasks(!!p.onOpenTask);
  const { items: assetItems } = useAssets(!!p.onOpenAsset);
  const q = p.query.trim();
  const tasks = useMemo(
    () =>
      rankItems(
        [...(data?.tasks ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
        q,
        (x) => [
          { text: x.title, weight: 3, highlight: true },
          { text: x.goal, weight: 1 },
        ],
      ),
    [data, q],
  );
  const assets = useMemo(
    () =>
      rankItems(
        [...(assetItems ?? [])].sort((a, b) => b.createdAt - a.createdAt),
        q,
        (x) => [
          { text: assetTitle(x), weight: 3, highlight: true },
          { text: sourceName(x.source), weight: 1 },
        ],
      ),
    [assetItems, q],
  );
  const tabs: SearchTab[] = ['all', 'chats'];
  if (p.onOpenTask) tabs.push('tasks');
  if (p.onOpenAsset) tabs.push('assets');
  const showChats = tab === 'all' || tab === 'chats';
  // 「全部」里任务 / 素材只在有输入时出现（没输入时是快捷操作 + 最近对话），各取前几条
  const showTasks = !!p.onOpenTask && (tab === 'tasks' || (tab === 'all' && !!q));
  const showAssets = !!p.onOpenAsset && (tab === 'assets' || (tab === 'all' && !!q));
  const cap = <T,>(list: T[]) => (tab === 'all' ? list.slice(0, 5) : list.slice(0, 50));
  useEffect(() => {
    p.inputRef.current?.focus();
  }, [p.inputRef]);
  const sel = Math.min(p.activeIdx, Math.max(p.shown.length - 1, 0));
  const cwdOf = (m: Meta) => m.cwd || (m.tabId ? p.tabById.get(m.tabId)?.cwd : '') || '';

  return createPortal(
    <div
      className={styles.searchOverlay}
      data-testid="sidebar-search-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <div
        className={styles.searchDialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('ui.cli-monitor.search-conversations')}
        data-testid="sidebar-search"
      >
        <div className={styles.searchBox} role="search">
          <span className={styles.searchGlyph} aria-hidden>
            <SearchIcon />
          </span>
          <input
            ref={p.inputRef}
            className={styles.searchInput}
            type="text"
            role="searchbox"
            value={p.query}
            placeholder={t('ui.cli-monitor.search-conversations-ellipsis')}
            aria-label={t('ui.cli-monitor.search-conversations')}
            aria-controls="sidebar-search-results"
            aria-activedescendant={p.searching && p.shown.length ? `sb-result-${sel}` : undefined}
            autoComplete="off"
            spellCheck={false}
            data-testid="sidebar-search-input"
            onChange={(e) => p.onQuery(e.target.value)}
            onKeyDown={p.onKeyDown}
          />
          <button
            type="button"
            className={styles.searchClear}
            title={p.query ? t('ui.cli-monitor.clear-search') : t('ui.cli-monitor.close-search')}
            aria-label={
              p.query ? t('ui.cli-monitor.clear-search') : t('ui.cli-monitor.close-search')
            }
            data-testid="sidebar-search-clear"
            onClick={() => (p.query ? (p.onQuery(''), p.inputRef.current?.focus()) : p.onClose())}
          >
            <Icon icon={X} size={14} />
          </button>
        </div>

        <div className={styles.searchBody}>
          {showChats && !p.searching && (
            <>
              <div className={styles.sectionTitle}>{t('ui.cli-monitor.quick-actions')}</div>
              <button
                type="button"
                className={`${styles.thread} ${styles.resultRow}`}
                data-layout="icon"
                data-testid="search-new-chat"
                onClick={() => {
                  p.onClose();
                  p.onNew();
                }}
              >
                <Icon icon={SquarePen} size={14} />
                <span className={styles.threadName}>{p.newLabel}</span>
                <span className={styles.threadTime}>{p.newHint}</span>
              </button>
              {p.recent.length > 0 && (
                <div className={styles.sectionTitle}>{t('ui.cli-monitor.recent-chats')}</div>
              )}
              {p.recent.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`${styles.thread} ${styles.resultRow}`}
                  data-layout="icon"
                  data-testid="search-recent"
                  data-conversation-id={c.id}
                  onClick={() => p.onOpenConv(c.id)}
                >
                  <Icon icon={MessageSquare} size={14} />
                  <span className={styles.threadName}>
                    {c.name ? t(c.name) : t('ui.chat-settings.new-chat')}
                  </span>
                  <span className={styles.threadTime}>{baseName(cwdOf(c))}</span>
                </button>
              ))}
            </>
          )}
          {showChats && p.searching && (
            <div
              id="sidebar-search-results"
              role="listbox"
              aria-label={t('ui.cli-monitor.search-results')}
              data-testid="sidebar-search-results"
            >
              <div
                className={styles.sectionTitle}
                aria-live="polite"
                data-testid="sidebar-search-count"
              >
                {t('ui.cli-monitor.search-results-count', p.total)}
                {p.indexing ? ['', t('ui.cli-monitor.indexing-history')].join(' · ') : ''}
              </div>
              {p.shown.map(({ item, ranges }, i) => {
                const selected = i === sel;
                const cls = `${styles.thread} ${styles.resultRow} ${selected ? styles.resultActive : ''}`;
                if (item.kind === 'conv') {
                  const c = item.meta;
                  return (
                    <button
                      key={item.id}
                      id={`sb-result-${i}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={cls}
                      data-testid="search-result"
                      data-kind="conv"
                      data-backend={c.backend}
                      data-conversation-id={c.id}
                      title={[item.title, item.cwd].filter(Boolean).join('\n')}
                      onMouseMove={() => p.onActive(i)}
                      onClick={() => p.onOpenConv(c.id)}
                      onContextMenu={(e) => p.onCtx(c.id, e)}
                    >
                      <span
                        className={styles.dot}
                        data-live={
                          liveOf(c.tabId ? p.tabById.get(c.tabId) : undefined) || undefined
                        }
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
                    className={`${cls} ${styles.histRow}`}
                    data-testid="search-result"
                    data-kind="hist"
                    data-backend={h.backend}
                    data-session-id={h.sessionId}
                    data-cwd-missing={h.cwdMissing || undefined}
                    aria-busy={p.openingKey === h.key}
                    title={[h.title, h.cwd].filter(Boolean).join('\n')}
                    onMouseMove={() => p.onActive(i)}
                    onClick={() => p.onOpenHist(h)}
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
              {p.total > p.max && (
                <div className={styles.empty} data-testid="sidebar-search-capped">
                  {t('ui.cli-monitor.showing-the-first-only-type-more-to-narrow', p.max)}
                </div>
              )}
              {p.total === 0 && (
                <div className={styles.empty} data-testid="sidebar-search-empty">
                  {p.indexing
                    ? t('ui.cli-monitor.searching')
                    : t('ui.cli-monitor.no-matching-conversations')}
                </div>
              )}
              {p.canSearchMore && (
                <button
                  type="button"
                  className={styles.histMore}
                  onClick={p.onSearchMore}
                  disabled={p.indexing}
                  data-testid="sidebar-search-more"
                >
                  {p.indexing
                    ? t('ui.mascot-theme.loading')
                    : t('ui.cli-monitor.search-older-history')}
                </button>
              )}
            </div>
          )}
          {showTasks && (
            <>
              <div className={styles.sectionTitle}>{t('ui.providers-schedule.tasks')}</div>
              {tasks.length === 0 && (
                <div className={styles.empty}>{t('ui.cli-monitor.no-matching-tasks')}</div>
              )}
              {cap(tasks).map(({ item, ranges }) => (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles.thread} ${styles.resultRow}`}
                  data-layout="icon"
                  data-testid="search-task"
                  title={[item.title, item.goal].filter(Boolean).join('\n')}
                  onClick={() => {
                    p.onClose();
                    p.onOpenTask?.(item.id);
                  }}
                >
                  <Icon icon={ListChecks} size={14} />
                  <span className={styles.threadName}>
                    <Highlight text={item.title} ranges={ranges} />
                  </span>
                  <span className={styles.threadTime}>{rel(item.updatedAt)}</span>
                </button>
              ))}
            </>
          )}
          {showAssets && (
            <>
              <div className={styles.sectionTitle}>{t('ui.media.asset-library')}</div>
              {assets.length === 0 && (
                <div className={styles.empty}>{t('ui.cli-monitor.no-matching-assets')}</div>
              )}
              {tab === 'assets' ? (
                // 素材库标签：缩略图网格，下面一行提示词
                <div className={styles.searchAssetGrid}>
                  {cap(assets).map(({ item }) => (
                    <button
                      key={item.file}
                      type="button"
                      className={styles.searchAssetTile}
                      data-testid="search-asset"
                      title={assetTitle(item)}
                      onClick={() => {
                        p.onClose();
                        p.onOpenAsset?.(item.file);
                      }}
                    >
                      <img
                        src={hostAssetUrl(item.url)}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                      <span className={styles.searchAssetName}>{assetTitle(item)}</span>
                    </button>
                  ))}
                </div>
              ) : (
                cap(assets).map(({ item, ranges }) => (
                  <button
                    key={item.file}
                    type="button"
                    className={`${styles.thread} ${styles.resultRow}`}
                    data-layout="thumb"
                    data-testid="search-asset"
                    title={assetTitle(item)}
                    onClick={() => {
                      p.onClose();
                      p.onOpenAsset?.(item.file);
                    }}
                  >
                    <img
                      className={styles.searchThumb}
                      src={hostAssetUrl(item.url)}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                    <span className={styles.threadName}>
                      <Highlight text={assetTitle(item)} ranges={ranges} />
                    </span>
                    <span className={styles.threadTime}>{sourceName(item.source)}</span>
                  </button>
                ))
              )}
            </>
          )}
        </div>
        {/* 底部标签（Codex 式）：全部 / 对话 / 任务 / 素材库 */}
        <div
          className={styles.searchTabs}
          role="tablist"
          aria-label={t('ui.cli-monitor.search-conversations')}
        >
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={styles.searchTab}
              onClick={() => {
                setTab(id);
                p.inputRef.current?.focus();
              }}
              data-testid={`search-tab-${id}`}
            >
              {tabLabel(id)}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
};
