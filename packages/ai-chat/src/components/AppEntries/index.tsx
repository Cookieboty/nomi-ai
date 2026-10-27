/**
 * 侧栏底部：应用级入口（设置 · 知识 · 记忆 · 日程 · 扩展 / MCP）。
 * 它们与当前对话无关，所以不放在对话列顶栏；展开时一行（设置带文字），侧栏收起时竖排只显示图标。
 * 侧栏 overflow: hidden 会裁掉 CSS 提示，这里用原生 title。
 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import { Blocks, LibraryBig, Settings, type LucideIcon } from 'lucide-react';
import React from 'react';

import { extClient } from '../../services/extClient';
import { kbClient } from '../../services/kbClient';
import { memClient } from '../../services/memClient';
import { schedClient } from '../../services/schedClient';
import { formatCombo, useShortcutBindings } from '../../services/shortcuts';
import { RestartUpdateButton } from '../RestartUpdateButton';

import styles from './index.module.css';

export interface AppEntriesProps {
  /** 侧栏收起：竖排、只显示图标 */
  collapsed: boolean;
  /** 设置 → 知识与记忆（知识库 / 长期记忆 / 日程） */
  onHub: () => void;
  onExt: () => void;
  onSettings: () => void;
}

interface Entry {
  id: string;
  icon: LucideIcon;
  tip: string;
  key: string;
  on: () => void;
  show: boolean;
}

export const AppEntries: React.FC<AppEntriesProps> = (p) => {
  // 作为 useMemo 缓存的 footer 元素挂在 memo 侧栏里：自己订阅语言
  useLocale();
  const bindings = useShortcutBindings();
  const settingsTip = t('ui.foundation.settings');
  const settingsKey = formatCombo(bindings.settings);
  const panels: Entry[] = [
    {
      id: 'open-hub-panel',
      icon: LibraryBig,
      tip: t('ui.chat-settings.knowledge-memory-schedule'),
      key: formatCombo(bindings.hub),
      on: p.onHub,
      show: memClient.available() || kbClient.available() || schedClient.available(),
    },
    {
      id: 'open-ext-panel',
      icon: Blocks,
      tip: t('ui.foundation.extensions-mcp'),
      key: formatCombo(bindings.ext),
      on: p.onExt,
      show: extClient.available(),
    },
  ].filter((e) => e.show);

  return (
    <nav
      className={styles.bar}
      data-collapsed={p.collapsed || undefined}
      aria-label={t('ui.foundation.app-shortcuts')}
      data-testid="app-entries"
    >
      <button
        type="button"
        className={`${styles.btn} ${p.collapsed ? '' : styles.settings}`}
        onClick={p.onSettings}
        title={`${settingsTip}  ${settingsKey}`}
        aria-label={settingsTip}
        data-testid="open-settings"
      >
        <Icon icon={Settings} size={16} />
        {!p.collapsed && <span>{settingsTip}</span>}
      </button>
      <RestartUpdateButton placement="sidebar" collapsed={p.collapsed} />
      {!p.collapsed && <span className={styles.spacer} />}
      {panels.map((e) => (
        <button
          key={e.id}
          type="button"
          className={styles.btn}
          onClick={e.on}
          title={`${e.tip}  ${e.key}`}
          aria-label={e.tip}
          data-testid={e.id}
        >
          <Icon icon={e.icon} size={16} />
        </button>
      ))}
    </nav>
  );
};
