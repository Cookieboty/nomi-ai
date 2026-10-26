/**
 * 侧栏顶部固定入口：新对话 / 图片工作台 / 素材库（在会话列表上方，不随列表滚动）。
 */
import { Icon, t } from '@nomi-ai/ui';
import { Images, Palette, SquarePen } from 'lucide-react';
import React from 'react';

import { mediaClient } from '../../services/mediaClient';

import styles from './Media.module.css';

export interface MediaNavProps {
  collapsed: boolean;
  onNewChat: () => void;
  onStudio: () => void;
  onLibrary: () => void;
}

export const MediaNav: React.FC<MediaNavProps> = ({
  collapsed,
  onNewChat,
  onStudio,
  onLibrary,
}) => {
  const items = [
    { id: 'nav-new-chat', icon: SquarePen, label: t('ui.chat-settings.new-chat'), on: onNewChat },
    ...(mediaClient.available()
      ? [
          { id: 'nav-image-studio', icon: Palette, label: t('ui.media.nav-studio'), on: onStudio },
          {
            id: 'nav-asset-library',
            icon: Images,
            label: t('ui.media.nav-library'),
            on: onLibrary,
          },
        ]
      : []),
  ];
  return (
    <nav
      className={styles.nav}
      data-collapsed={collapsed || undefined}
      aria-label={t('ui.media.nav-label')}
      data-testid="sidebar-fixed-nav"
    >
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={styles.navBtn}
          onClick={it.on}
          title={it.label}
          aria-label={it.label}
          data-testid={it.id}
        >
          <Icon icon={it.icon} size={16} />
          {!collapsed && <span>{it.label}</span>}
        </button>
      ))}
    </nav>
  );
};
