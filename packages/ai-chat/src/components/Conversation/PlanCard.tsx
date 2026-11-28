/** ACP 结构化执行计划（plan / plan_update）与 todo 工具清单渲染卡片 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import {
  IconAlertCircle as CircleAlert,
  IconCircle as Circle,
  IconCircleCheck as CircleCheck,
  IconCircleMinus as CircleMinus,
  IconLoader2 as LoaderCircle,
} from '@tabler/icons-react';
import type { TablerIcon as IconGlyph } from '@tabler/icons-react';
import React from 'react';

import type { PlanEntry, PlanEntryStatus } from '../../services/harnessClient';

import { Markdown } from './Markdown';
import styles from './Tool.module.css';

const STATUS_ICON: Record<PlanEntryStatus, IconGlyph> = {
  completed: CircleCheck,
  in_progress: LoaderCircle,
  pending: Circle,
  failed: CircleAlert,
  skipped: CircleMinus,
};

export const PlanEntryList: React.FC<{
  entries: readonly PlanEntry[];
  scrollable?: boolean;
}> = ({ entries, scrollable }) => (
  <ul
    className={styles.planList}
    data-testid="plan-list"
    data-scrollable={scrollable ? 'true' : undefined}
  >
    {entries.map((entry, idx) => (
      <li
        key={`${idx}-${entry.content}`}
        className={styles.planItem}
        data-status={entry.status}
        data-testid="plan-item"
      >
        <span className={styles.planIcon} aria-hidden="true">
          <Icon icon={STATUS_ICON[entry.status]} size={15} />
        </span>
        <span className={styles.planText}>{entry.content}</span>
      </li>
    ))}
  </ul>
);

export const PlanCard: React.FC<{
  entries: readonly PlanEntry[];
  markdown?: string;
  uri?: string;
}> = ({ entries, markdown, uri }) => {
  useLocale();
  return (
    <div
      className={styles.planCard}
      role="region"
      aria-label={t('ui.usage-tools.plan-title')}
      data-testid="plan-card"
      data-no-selection-toolbar=""
    >
      {entries.length > 0 ? (
        <PlanEntryList entries={entries} scrollable={entries.length > 10} />
      ) : markdown ? (
        <div className={styles.planMarkdown} data-testid="plan-markdown">
          <Markdown text={markdown} settled />
        </div>
      ) : null}
      {uri && (
        <div className={styles.planUri} data-testid="plan-uri">
          {uri}
        </div>
      )}
    </div>
  );
};
