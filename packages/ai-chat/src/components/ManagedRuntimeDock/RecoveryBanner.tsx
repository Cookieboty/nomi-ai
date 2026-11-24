import { t } from '@nomi-ai/ui';
import React from 'react';

import styles from './index.module.css';
import type { ManagedRuntimeView } from './types';

export const RecoveryBanner: React.FC<{
  view: ManagedRuntimeView;
  activeName: string;
  onResolve: (decision?: 'new-native' | 'rollback-switch') => void;
}> = ({ view, activeName, onResolve }) => {
  if (!view.managed) return null;

  const unknown = view.phase === 'uncertain' && view.recovery === 'unknown';
  const hasPendingSwitch = Boolean(view.pendingSwitch);

  if (!unknown && !hasPendingSwitch) return null;

  const recoveryNote = hasPendingSwitch
    ? t('ui.chat-settings.managed-switch-interrupted', view.pendingSwitch!.phase)
    : '';

  return (
    <div className={styles.recovery} data-testid="managed-recovery-banner">
      {recoveryNote && (
        <p className={styles.note} data-testid="managed-recovery-status">
          {recoveryNote}
        </p>
      )}
      <div className={styles.actions}>
        {hasPendingSwitch && (
          <button
            type="button"
            className={styles.btnPrimary}
            data-testid="managed-runtime-rollback-switch"
            onClick={() => onResolve('rollback-switch')}
          >
            {t('ui.chat-settings.managed-rollback-switch')}
          </button>
        )}
        {unknown && !hasPendingSwitch && (
          <button
            type="button"
            className={styles.btnPrimary}
            data-testid="managed-runtime-new-native"
            onClick={() => onResolve('new-native')}
          >
            {t('ui.chat-settings.managed-new-native', activeName)}
          </button>
        )}
      </div>
    </div>
  );
};
