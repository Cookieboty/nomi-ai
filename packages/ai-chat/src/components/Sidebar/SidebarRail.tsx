import { t } from '@nomi-ai/ui';
import React from 'react';

import type {
  ConversationListView,
  EndpointVisibility,
  EndpointVisibilityMap,
} from '../../services/chatPrefs';
import type { ConversationBackend } from '../../types/chat';

import { EndpointRail } from './EndpointRail';
import { SIDEBAR_ICONS } from './icons';
import styles from './index.module.css';
import { SideNavItem } from './SideNavItem';

interface SidebarRailProps {
  panelHidden: boolean;
  collapsed: boolean;
  pageOpen?: boolean;
  topNav?: React.ReactNode;
  footer?: React.ReactNode;
  showEndpoints: boolean;
  view: ConversationListView;
  endpointFilter: ConversationBackend;
  railEndpoints: ConversationBackend[];
  allEndpoints: readonly ConversationBackend[];
  endpointActivity: Partial<Record<ConversationBackend, number>>;
  endpointVisibility: EndpointVisibilityMap;
  endpointOrder: ConversationBackend[] | null;
  cliMissing: (b: ConversationBackend) => boolean;
  tipOf: (b: ConversationBackend) => string;
  onShowFloat: () => void;
  onLeavePage: () => void;
  onAll: () => void;
  onPick: (b: ConversationBackend) => void;
  onReorder: (order: readonly ConversationBackend[] | null) => void;
  onVisibility: (b: ConversationBackend, v: EndpointVisibility) => void;
}

/** 左侧固定导航：对话 · 任务 · 素材库；工作台模式下端点竖排挂在下面；底部是应用级入口 */
export const SidebarRail: React.FC<SidebarRailProps> = ({
  panelHidden,
  collapsed,
  pageOpen,
  topNav,
  footer,
  showEndpoints,
  view,
  endpointFilter,
  railEndpoints,
  allEndpoints,
  endpointActivity,
  endpointVisibility,
  endpointOrder,
  cliMissing,
  tipOf,
  onShowFloat,
  onLeavePage,
  onAll,
  onPick,
  onReorder,
  onVisibility,
}) => {
  const hoverProps =
    !panelHidden && collapsed ? { onMouseEnter: onShowFloat, onFocus: onShowFloat } : {};
  return (
    <div className={styles.rail} data-testid="app-rail">
      <nav className={styles.railNav} aria-label={t('ui.foundation.app-shortcuts')}>
        {/* 收起时悬停 / 聚焦「对话」弹出会话浮层 */}
        <span className={styles.railHover} {...hoverProps}>
          <SideNavItem
            icon={SIDEBAR_ICONS.chats}
            label={t('ui.chat-settings.chats')}
            collapsed
            active={!pageOpen}
            onOpen={() => {
              onLeavePage();
              if (collapsed) onShowFloat();
            }}
            testId="nav-chats"
          />
        </span>
        {topNav}
      </nav>
      {showEndpoints && (
        <span className={styles.railHover} {...hoverProps}>
          <EndpointRail
            active={!panelHidden && view === 'by-endpoint' ? endpointFilter : null}
            shown={railEndpoints}
            ordered={allEndpoints}
            activity={endpointActivity}
            visibility={endpointVisibility}
            customOrder={endpointOrder !== null}
            isDisabled={cliMissing}
            tipOf={tipOf}
            onAll={() => {
              onLeavePage();
              onAll();
            }}
            onPick={onPick}
            onReorder={onReorder}
            onVisibility={onVisibility}
          />
        </span>
      )}
      <span className={styles.railSpacer} />
      {footer}
    </div>
  );
};
