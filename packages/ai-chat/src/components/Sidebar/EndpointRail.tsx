import { Icon, t } from '@nomi-ai/ui';
import { Layers } from 'lucide-react';
import React from 'react';

import type { EndpointVisibility, EndpointVisibilityMap } from '../../services/chatPrefs';
import type { ConversationBackend } from '../../types/chat';
import { EndpointIcon } from '../EndpointIcon';

import { EndpointVisibilityMenu } from './EndpointVisibilityMenu';
import styles from './index.module.css';

/**
 * 工作台模式：左侧导航栏里竖排的端点（「全部」+ Nomi 与各编程助手），点一下切到该端的会话。
 * 全部显示、只排序；数量与安装状态在悬停提示里；「显示设置」的弹出层向右展开。
 */
export const EndpointRail: React.FC<{
  allActive: boolean;
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
  const allLabel = t('ui.providers-schedule.all');
  return (
    <div
      className={styles.epRail}
      role="group"
      aria-label={t('ui.cli-monitor.filter-by-endpoint')}
      data-testid="endpoint-rail"
    >
      <button
        type="button"
        className={styles.epChip}
        aria-pressed={p.allActive}
        aria-label={allLabel}
        data-testid="list-view-all"
        onClick={p.onAll}
      >
        <Icon icon={Layers} size={16} />
      </button>
      {p.shown.map((b) => {
        const tip = p.tipOf(b);
        return (
          <button
            key={b}
            type="button"
            className={styles.epChip}
            aria-pressed={p.active === b}
            aria-label={tip}
            disabled={p.isDisabled(b)}
            data-testid={`endpoint-filter-${b}`}
            onClick={() => p.onPick(b)}
          >
            <EndpointIcon backend={b} size={16} decorative />
          </button>
        );
      })}
      <EndpointVisibilityMenu
        backends={p.ordered}
        visibility={p.visibility}
        activity={p.activity}
        customOrder={p.customOrder}
        onReorder={p.onReorder}
        onChange={p.onVisibility}
      />
    </div>
  );
};
