import { t } from '@nomi-ai/ui';
import React from 'react';

import { SIDEBAR_W_MAX, SIDEBAR_W_MIN } from '../utils/sidebarWidth';

import type { SplitWidth } from './useSplitWidths';

/**
 * 会话面板 | 对话卡片之间的拖动手柄（#333）：不占宽度（负外边距），压在两者交界上，
 * 悬停 / 拖动时光标变左右调整、交界处亮一条强调色细线（样式见 App.css 的 .sidebar-splitter）。
 * 放在 App 里而不是 Sidebar 里：Sidebar 是 React.memo，宽度变化不该让整个会话列表重渲染。
 */
export const SidebarSplitter: React.FC<{ split: SplitWidth }> = ({ split }) => (
  <div
    className="sidebar-splitter"
    data-testid="sidebar-splitter"
    role="separator"
    aria-orientation="vertical"
    aria-label={t('ui.chat-settings.resize-sidebar')}
    aria-valuenow={split.width}
    aria-valuemin={SIDEBAR_W_MIN}
    aria-valuemax={SIDEBAR_W_MAX}
    title={t('ui.chat-settings.resize-sidebar')}
    onPointerDown={split.onPointerDown}
    onDoubleClick={split.onDoubleClick}
  />
);
