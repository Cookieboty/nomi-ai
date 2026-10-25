/** 顶栏右侧：展开 / 收起右栏（改动 · 文件），带本会话变更文件数 */
import { Icon, t, Tooltip } from '@nomi-ai/ui';
import { PanelRight } from 'lucide-react';
import React from 'react';

import styles from './FilesRailToggle.module.css';

export const FilesRailToggle: React.FC<{
  open: boolean;
  /** 本会话改过的文件数 */
  count: number;
  onToggle: () => void;
}> = ({ open, count, onToggle }) => {
  const label = open
    ? t('ui.session-workspace.hide-changes-panel')
    : t('ui.session-workspace.show-changes-panel');
  return (
    <Tooltip placement="bottom" content={label}>
      <button
        type="button"
        className={styles.toggle}
        aria-label={count ? t('ui.session-workspace.files-changed', label, String(count)) : label}
        aria-pressed={open}
        data-open={open || undefined}
        data-testid="files-rail-toggle"
        onClick={onToggle}
      >
        <Icon icon={PanelRight} size={16} />
        {count > 0 && (
          <span className={styles.count} data-testid="files-rail-toggle-count">
            {count}
          </span>
        )}
      </button>
    </Tooltip>
  );
};
