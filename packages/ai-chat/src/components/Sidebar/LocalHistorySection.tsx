import { Icon, t } from '@nomi-ai/ui';
import { RefreshCw } from 'lucide-react';
import React, { useState } from 'react';

import type { HistorySession } from '../../services/historyClient';

import styles from './index.module.css';
import { SectionHeader } from './SectionHeader';
import { HistoryRow } from './SidebarRows';

/** 侧栏「本机历史」：磁盘上的 CLI 会话，默认折叠（点标题展开；不记住） */
export const LocalHistorySection: React.FC<{
  items: readonly HistorySession[];
  scanning: boolean;
  openingKey: string | null | undefined;
  onOpen: (h: HistorySession) => void;
  onMenu: (h: HistorySession, x: number, y: number, anchor?: HTMLElement) => void;
  onDelete: (h: HistorySession) => void;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  /** 标题右侧的「刷新」：重新扫描各 CLI 的本机历史 */
  onRefresh?: () => void;
}> = ({
  items,
  scanning,
  openingKey,
  onOpen,
  onMenu,
  onDelete,
  hasMore,
  loading,
  onLoadMore,
  onRefresh,
}) => {
  const [open, setOpen] = useState(false);
  const label = open
    ? t('ui.cli-monitor.collapse-local-history')
    : t('ui.cli-monitor.expand-local-history');
  return (
    <div className={styles.histSection} data-testid="cli-history">
      <SectionHeader
        label={t('ui.cli-monitor.local-history')}
        title={label}
        open={open}
        onToggle={() => setOpen((v) => !v)}
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
            onDelete={() => onDelete(h)}
          />
        ))}
      {open && hasMore && (
        <button
          type="button"
          className={styles.histMore}
          onClick={onLoadMore}
          disabled={loading}
          data-testid="cli-history-more"
        >
          {loading ? t('ui.mascot-theme.loading') : t('ui.cli-monitor.load-more')}
        </button>
      )}
    </div>
  );
};
