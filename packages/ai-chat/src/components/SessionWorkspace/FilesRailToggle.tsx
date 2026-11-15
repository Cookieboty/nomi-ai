/** 顶栏右侧：显示 / 隐藏对话旁的标签页（替代原来的变更栏开关） */
import { Icon, t, Tooltip } from '@nomi-ai/ui';
import {
  IconLayoutSidebarRightCollapse as CollapseTabs,
  IconLayoutSidebarRightExpand as ExpandTabs,
} from '@tabler/icons-react';
import React from 'react';

import { formatCombo, useShortcutBindings } from '../../services/shortcuts';

import styles from './FilesRailToggle.module.css';

export const FilesRailToggle: React.FC<{
  open: boolean;
  /** 本会话改过的文件数 */
  count: number;
  onToggle: () => void;
  /** 传给 Tooltip 气泡的额外 class（如顶栏右对齐时修正定位） */
  bubbleClassName?: string;
}> = ({ open, count, onToggle, bubbleClassName }) => {
  const bindings = useShortcutBindings();
  const combo = formatCombo(bindings.toggleTabs);
  const label = open ? t('ui.session-workspace.hide-tabs') : t('ui.session-workspace.show-tabs');
  return (
    <Tooltip
      placement="bottom"
      content={
        <>
          {label}
          <span className={styles.shortcut}>{combo}</span>
        </>
      }
      bubbleClassName={bubbleClassName}
    >
      <button
        type="button"
        className={styles.toggle}
        aria-label={count ? t('ui.session-workspace.files-changed', label, String(count)) : label}
        aria-pressed={open}
        data-open={open || undefined}
        data-testid="side-tabs-toggle"
        onClick={onToggle}
      >
        <Icon icon={open ? CollapseTabs : ExpandTabs} size={16} />
        {count > 0 && (
          <span className={styles.count} data-testid="side-tabs-toggle-count">
            {count}
          </span>
        )}
      </button>
    </Tooltip>
  );
};
