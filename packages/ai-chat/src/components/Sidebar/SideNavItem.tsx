import { Icon } from '@nomi-ai/ui';
import type { LucideIcon } from 'lucide-react';
import React from 'react';

import styles from './SideNavItem.module.css';

/**
 * 侧栏会话列表上方的页面入口（任务、素材库）：与会话行同一套形态——无边框、悬停浅底，
 * 打开时用选中底色 + 左侧强调条；收起侧栏时只剩图标。
 * `badge` 是要你处理的数量（醒目；收起时只是图标右上角一个小圆点，数量在悬停提示与读屏文字里），`count` 是普通计数（弱化）；`load` 给图标加一圈负载色（Agent 看板）。
 */
export const SideNavItem: React.FC<{
  icon: LucideIcon;
  label: string;
  /** 读屏与悬停提示；默认同 label */
  title?: string;
  collapsed: boolean;
  active: boolean;
  count?: number;
  badge?: number;
  load?: 'warn' | 'critical';
  onOpen: () => void;
  testId: string;
}> = ({ icon, label, title, collapsed, active, count, badge, load, onOpen, testId }) => (
  <button
    type="button"
    className={styles.item}
    data-collapsed={collapsed || undefined}
    aria-current={active ? 'page' : undefined}
    aria-label={title ?? label}
    title={title ?? label}
    onClick={onOpen}
    data-testid={testId}
  >
    <span className={styles.iconWrap} data-load={load}>
      <Icon icon={icon} size={16} className={styles.icon} />
    </span>
    {!collapsed && <span className={styles.label}>{label}</span>}
    {badge ? (
      collapsed ? (
        <span className={styles.dot} data-testid={`${testId}-dot`} aria-hidden />
      ) : (
        <span className={styles.badge}>{badge}</span>
      )
    ) : (
      !collapsed && !!count && <span className={styles.count}>{count}</span>
    )}
  </button>
);
