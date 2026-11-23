import { t } from '@nomi-ai/ui';
import React from 'react';

import styles from './index.module.css';
import type { BridgeStatus, CapabilityBridgesView } from './types';

const CAPABILITY_ROWS: ReadonlyArray<{
  key: keyof CapabilityBridgesView;
  labelKey: string;
}> = [
  { key: 'computer', labelKey: 'ui.chat-settings.managed-cap-computer' },
  { key: 'mcp', labelKey: 'ui.chat-settings.managed-cap-mcp' },
  { key: 'persona', labelKey: 'ui.chat-settings.managed-cap-persona' },
  { key: 'memory', labelKey: 'ui.knowledge-local.conversation-memories' },
  { key: 'knowledge', labelKey: 'ui.foundation.knowledge-base' },
  { key: 'skills', labelKey: 'ui.foundation.skills-label' },
  { key: 'attachments', labelKey: 'ui.chat-settings.managed-cap-attachments' },
];

const STATUS_KEYS: Record<BridgeStatus, string> = {
  native: 'ui.chat-settings.managed-cap-status-native',
  bridged: 'ui.chat-settings.managed-cap-status-bridged',
  degraded: 'ui.chat-settings.managed-cap-status-degraded',
  unsupported: 'ui.slash-commands.unsupported',
};

export const CapabilityMatrix: React.FC<{
  bridges?: CapabilityBridgesView;
  embedded?: boolean;
}> = ({ bridges, embedded }) => {
  if (!bridges) return null;
  const grid = (
    <div
      className={styles.capGrid}
      data-testid={embedded ? 'managed-capability-matrix' : undefined}
    >
      {CAPABILITY_ROWS.map(({ key, labelKey }) => {
        const item = bridges[key];
        return (
          <div key={key} className={styles.capRow} data-testid={`managed-cap-${key}`}>
            <span className={styles.capName}>{t(labelKey)}</span>
            <span className={`${styles.capBadge} ${styles[`cap_${item.status}`] ?? ''}`}>
              {t(STATUS_KEYS[item.status])}
            </span>
            {item.detail && <span className={styles.capDetail}>{item.detail}</span>}
          </div>
        );
      })}
    </div>
  );
  if (embedded) return grid;
  return (
    <details className={styles.details} data-testid="managed-capability-matrix">
      <summary className={styles.summary}>{t('ui.chat-settings.managed-cap-title')}</summary>
      {grid}
    </details>
  );
};
