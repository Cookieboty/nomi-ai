import { Icon, Tooltip } from '@nomi-ai/ui';
import type { TablerIcon as IconGlyph } from '@tabler/icons-react';
import React from 'react';

import styles from './SideNavItem.module.css';

/**
 * 侧栏会话列表上方的页面入口（任务、素材库）：与会话行同一套形态——无边框、悬停浅底，
 * 打开时用圆角选中底色；收起侧栏时只剩图标。
 * `badge` 是要你处理的数量（醒目；收起时只是图标右上角一个小圆点，数量在悬停提示与读屏文字里），`count` 是普通计数（弱化）。
 *
 * 悬停 / 键盘聚焦时在图标右侧弹出自绘提示：这些入口常年只显示图标，光有读屏名称看不出是什么。
 * 气泡放右侧（--right）而不是上方 / 内侧：侧栏祖先有 overflow: hidden，放内侧会被裁掉。
 * 读屏名称仍走 aria-label，不写原生 title（全局 installTitleTooltips 会接管带 title 的元素）。
 */
export const SideNavItem: React.FC<{
  icon: IconGlyph;
  label: string;
  /** 读屏无障碍名；默认同 label。同时作为悬停提示的文案 */
  title?: string;
  collapsed: boolean;
  active: boolean;
  count?: number;
  badge?: number;
  onOpen: () => void;
  testId: string;
}> = ({ icon, label, title, collapsed, active, count, badge, onOpen, testId }) => {
  const tip = title ?? label;
  return (
    <Tooltip placement="right" content={tip} className={styles.tipHost}>
      <button
        type="button"
        className={styles.item}
        data-collapsed={collapsed || undefined}
        aria-current={active ? 'page' : undefined}
        aria-label={tip}
        onClick={onOpen}
        data-testid={testId}
      >
        <span className={styles.iconWrap}>
          <Icon icon={icon} size="nav" className={styles.icon} />
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
    </Tooltip>
  );
};
