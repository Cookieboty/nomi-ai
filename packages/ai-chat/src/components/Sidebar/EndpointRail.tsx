import { t, Tooltip } from '@nomi-ai/ui';
import React from 'react';

import type { EndpointVisibility, EndpointVisibilityMap } from '../../services/chatPrefs';
import type { ConversationBackend } from '../../types/chat';
import { EndpointIcon } from '../EndpointIcon';

import { EndpointVisibilityMenu } from './EndpointVisibilityMenu';
import styles from './index.module.css';

/**
 * 工作台模式：左侧导航栏里竖排的端点，选中后再次点击回到全部会话。
 * 全部显示、只排序；数量与安装状态在悬停提示里（气泡放右侧：侧栏祖先有 overflow: hidden）；
 * 「显示设置」的弹出层向右展开。
 */
export const EndpointRail: React.FC<{
  /** 正在看的端点（「按端」时）；「全部」时为 null */
  active: ConversationBackend | null;
  shown: readonly ConversationBackend[];
  ordered: readonly ConversationBackend[];
  activity: Partial<Record<ConversationBackend, number>>;
  visibility: EndpointVisibilityMap;
  customOrder: boolean;
  isDisabled: (b: ConversationBackend) => boolean;
  tipOf: (b: ConversationBackend) => string;
  onAll: () => void;
  onPick: (b: ConversationBackend) => void;
  onReorder: (order: readonly ConversationBackend[] | null) => void;
  onVisibility: (b: ConversationBackend, v: EndpointVisibility) => void;
}> = (p) => {
  return (
    <div
      className={styles.epRail}
      role="group"
      aria-label={t('ui.cli-monitor.filter-by-endpoint')}
      data-testid="endpoint-rail"
    >
      {p.shown.map((b) => {
        const tip = p.tipOf(b);
        return (
          <Tooltip key={b} placement="right" content={tip} className={styles.epChipTip}>
            <button
              type="button"
              className={styles.epChip}
              aria-pressed={p.active === b}
              aria-label={tip}
              disabled={p.isDisabled(b)}
              data-testid={`endpoint-filter-${b}`}
              onClick={() => (p.active === b ? p.onAll() : p.onPick(b))}
            >
              <EndpointIcon backend={b} size={18} variant="color" decorative />
            </button>
          </Tooltip>
        );
      })}
      <EndpointVisibilityMenu
        backends={p.ordered}
        visibility={p.visibility}
        activity={p.activity}
        shown={p.shown}
        customOrder={p.customOrder}
        onReorder={p.onReorder}
        onChange={p.onVisibility}
      />
    </div>
  );
};
