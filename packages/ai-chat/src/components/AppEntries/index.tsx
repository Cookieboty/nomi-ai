/**
 * 侧栏底部：应用级入口，只有「设置」。
 * 知识 · 记忆 · 日程、扩展 / MCP 不在这里放快捷入口：从输入栏的菜单、快捷键或命令面板打开。
 * 展开时设置带文字，在左侧导航栏里只显示图标。图标按钮只用 aria-label 命名。
 * 收起（只剩图标）时悬停 / 聚焦弹出自绘提示；展开时已有文字，不再重复提示。
 */
import { Icon, t, Tooltip, useLocale } from '@nomi-ai/ui';
import React from 'react';

import { SIDEBAR_ICONS } from '../Sidebar/icons';

import styles from './index.module.css';

export interface AppEntriesProps {
  /** 侧栏收起：只显示图标 */
  collapsed: boolean;
  onSettings: () => void;
  active?: boolean;
}

export const AppEntries: React.FC<AppEntriesProps> = (p) => {
  // 作为 useMemo 缓存的 footer 元素挂在 memo 侧栏里：自己订阅语言
  useLocale();
  const settingsTip = t('ui.foundation.settings');

  const settingsButton = (
    <button
      type="button"
      className={`${styles.btn} ${p.collapsed ? '' : styles.settings}`}
      onClick={p.onSettings}
      aria-current={p.active ? 'page' : undefined}
      aria-label={settingsTip}
      data-testid="open-settings"
    >
      <Icon icon={SIDEBAR_ICONS.settings} size="nav" />
      {!p.collapsed && <span>{settingsTip}</span>}
    </button>
  );

  return (
    <nav
      className={styles.bar}
      data-collapsed={p.collapsed || undefined}
      aria-label={t('ui.foundation.app-shortcuts')}
      data-testid="app-entries"
    >
      {!p.collapsed && <span className={styles.spacer} />}
      {p.collapsed ? (
        <Tooltip placement="right" content={settingsTip} className={styles.tipHost}>
          {settingsButton}
        </Tooltip>
      ) : (
        settingsButton
      )}
    </nav>
  );
};
