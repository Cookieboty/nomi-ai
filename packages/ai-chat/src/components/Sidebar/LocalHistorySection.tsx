import { Icon, t } from '@nomi-ai/ui';
import { IconRefresh as RefreshCw } from '@tabler/icons-react';
import React, { useEffect, useRef, useState } from 'react';

import type { HistorySession } from '../../services/historyClient';

import styles from './index.module.css';
import { SectionHeader } from './SectionHeader';
import { HistoryRow } from './SidebarRows';

/** 「本机历史」整个分区收起时记在折叠记录里的键（与项目 id 不会重名） */
export const SECTION_LOCAL_HISTORY = '\u0000section:local-history';

/** 侧栏「本机历史」：磁盘上的 CLI 会话，默认展开（手动收起后记住）；滚到底部自动加载下一页 */
export const LocalHistorySection: React.FC<{
  items: readonly HistorySession[];
  scanning: boolean;
  openingKey: string | null | undefined;
  onOpen: (h: HistorySession) => void;
  onMenu: (h: HistorySession, x: number, y: number, anchor?: HTMLElement) => void;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  /** 标题右侧的「刷新」：重新扫描各 CLI 的本机历史 */
  onRefresh?: () => void;
  /** 受控展开态；未传时默认展开并由组件内部维护 */
  open?: boolean;
  onToggle?: () => void;
}> = ({
  items,
  scanning,
  openingKey,
  onOpen,
  onMenu,
  hasMore,
  loading,
  onLoadMore,
  onRefresh,
  open: controlledOpen,
  onToggle,
}) => {
  const [localOpen, setLocalOpen] = useState(true);
  const open = controlledOpen ?? localOpen;
  const toggle = () => {
    if (onToggle) onToggle();
    else setLocalOpen((v) => !v);
  };

  const moreRef = useRef<HTMLButtonElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  const loadingRef = useRef(loading);
  const itemsLenRef = useRef(items.length);
  const lastAutoLenRef = useRef<number | null>(null);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
    loadingRef.current = loading;
  });

  useEffect(() => {
    itemsLenRef.current = items.length;
    lastAutoLenRef.current = null;
  }, [items.length]);

  useEffect(() => {
    if (!open || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const target = moreRef.current;
    if (!target) return;
    const root = target.closest<HTMLElement>('[data-testid="conversation-list"]') ?? null;
    // 无布局环境（如 happy-dom 未模拟滚区高度）不自动触发，保留手动点「加载更多」的行为
    if (root && root.clientHeight <= 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (loadingRef.current) return;
        if (lastAutoLenRef.current === itemsLenRef.current) return;
        lastAutoLenRef.current = itemsLenRef.current;
        onLoadMoreRef.current();
      },
      { root, rootMargin: '0px 0px 160px 0px', threshold: 0 },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [open, hasMore, items.length]);

  const label = open
    ? t('ui.cli-monitor.collapse-local-history')
    : t('ui.cli-monitor.expand-local-history');
  return (
    <div className={styles.histSection} data-testid="cli-history">
      <SectionHeader
        label={t('ui.cli-monitor.local-history')}
        title={label}
        open={open}
        onToggle={toggle}
        testId="cli-history-toggle"
        actions={
          onRefresh && (
            <button
              type="button"
              className={styles.headBtn}
              onClick={onRefresh}
              disabled={loading}
              aria-label={t('ui.cli-monitor.refresh-history')}
              data-testid="cli-history-refresh"
            >
              <Icon icon={RefreshCw} size={14} />
            </button>
          )
        }
      />
      {open && scanning && (
        <div className={styles.empty}>{t('ui.cli-monitor.scanning-history-sessions')}</div>
      )}
      {open &&
        items.map((h) => (
          <HistoryRow
            key={h.key}
            h={h}
            busy={openingKey === h.key}
            onOpen={() => onOpen(h)}
            onMenu={(x, y, anchor) => onMenu(h, x, y, anchor)}
          />
        ))}
      {open && hasMore && (
        <button
          ref={moreRef}
          type="button"
          className={styles.histMore}
          onClick={() => {
            lastAutoLenRef.current = null;
            onLoadMore();
          }}
          disabled={loading}
          data-testid="cli-history-more"
        >
          {loading ? t('ui.mascot-theme.loading') : t('ui.cli-monitor.load-more')}
        </button>
      )}
    </div>
  );
};
