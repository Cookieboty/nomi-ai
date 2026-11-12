/**
 * 侧栏底部：应用级入口，只有「设置」。
 * 知识 · 记忆 · 日程、扩展 / MCP 不在这里放快捷入口：从输入栏的菜单、快捷键或命令面板打开。
 * 展开时设置带文字，在左侧导航栏里只显示图标。图标按钮只用 aria-label 命名。
 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import React from 'react';

import { FEATURE_ICONS } from '../AppIcons';

import styles from './index.module.css';

export interface AppEntriesProps {
  /** 侧栏收起：只显示图标 */
  collapsed: boolean;
  onSettings: () => void;
}

export const AppEntries: React.FC<AppEntriesProps> = (p) => {
  // 作为 useMemo 缓存的 footer 元素挂在 memo 侧栏里：自己订阅语言
  useLocale();
  const settingsTip = t('ui.foundation.settings');

  return (
    <nav
      className={styles.bar}
      data-collapsed={p.collapsed || undefined}
      aria-label={t('ui.foundation.app-shortcuts')}
      data-testid="app-entries"
    >
      {!p.collapsed && <span className={styles.spacer} />}
      <button
        type="button"
        className={`${styles.btn} ${p.collapsed ? '' : styles.settings}`}
        onClick={p.onSettings}
        aria-label={settingsTip}
        data-testid="open-settings"
      >
        <Icon icon={FEATURE_ICONS.settings} size={16} />
        {!p.collapsed && <span>{settingsTip}</span>}
      </button>
    </nav>
  );
};
