import { t } from '@nomi-ai/ui';
import React from 'react';

import styles from './index.module.css';
import type { ManagedRuntimeView } from './types';

export const RecoveryBanner: React.FC<{
  view: ManagedRuntimeView;
  activeName: string;
  onResolve: (decision?: 'new-native' | 'rollback-switch' | 'abandon') => void;
}> = ({ view, activeName, onResolve }) => {
  if (!view.managed) return null;

  const unknown = view.phase === 'uncertain' && view.recovery === 'unknown';
  const hasPendingSwitch = Boolean(view.pendingSwitch);
  const canAbandon =
    !hasPendingSwitch &&
    (view.phase === 'uncertain' || (view.phase === 'canceled' && view.recovery === 'unknown'));

  const needsAttention = unknown || hasPendingSwitch || canAbandon;
  if (!needsAttention) return null;

  const recoveryNote = (() => {
    if (view.pendingSwitch) {
      return t('ui.chat-settings.managed-switch-interrupted', view.pendingSwitch.phase);
    }
    if (view.phase === 'uncertain' && view.recovery === 'error' && view.detail) {
      return t('ui.chat-settings.managed-recovery-error', view.detail);
    }
    return '';
  })();

  const hasActions = unknown || hasPendingSwitch || canAbandon;
  if (!recoveryNote && !hasActions) return null;

  return (
    <div className={styles.recovery} data-testid="managed-recovery-banner">
      {recoveryNote && (
        <p className={styles.note} data-testid="managed-recovery-status">
          {recoveryNote}
        </p>
      )}
      {hasActions && (
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
          {canAbandon && (
            <button
              type="button"
              className={styles.btn}
              data-testid="managed-runtime-abandon"
              onClick={() => onResolve('abandon')}
            >
              {t('ui.chat-settings.managed-abandon')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
