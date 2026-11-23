import { t } from '@nomi-ai/ui';
import React from 'react';

import styles from './index.module.css';
import type { FailedRequestView, ManagedRuntimeView } from './types';

export const RecoveryBanner: React.FC<{
  view: ManagedRuntimeView;
  activeName: string;
  onResolve: (decision?: 'new-native' | 'rollback-switch' | 'abandon') => void;
  onRetry?: (request: FailedRequestView) => void;
}> = ({ view, activeName, onResolve, onRetry }) => {
  if (!view.managed) return null;

  const unknown = view.phase === 'uncertain' && view.recovery === 'unknown';
  const hasPendingSwitch = Boolean(view.pendingSwitch);
  const canAbandon =
    view.phase === 'uncertain' || view.phase === 'failed-pre-submit' || view.phase === 'canceled';
  const showRetry =
    Boolean(view.failedRequest) && view.phase !== 'running' && view.phase !== 'preparing';

  const needsAttention =
    unknown ||
    hasPendingSwitch ||
    Boolean(view.failedRequest) ||
    view.phase === 'failed-pre-submit' ||
    view.recovery === 'error';
  if (!needsAttention) return null;

  const recoveryNote = (() => {
    if (view.pendingSwitch) {
      return t('ui.chat-settings.managed-switch-interrupted', view.pendingSwitch.phase);
    }
    if (view.phase === 'failed-pre-submit' && view.detail) {
      return t('ui.chat-settings.managed-recovery-error', view.detail);
    }
    if (view.recovery === 'error') {
      return view.detail ? t('ui.chat-settings.managed-recovery-error', view.detail) : '';
    }
    return '';
  })();

  const hasActions = unknown || hasPendingSwitch || (canAbandon && view.failedRequest) || showRetry;
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
          {showRetry && onRetry && view.failedRequest && (
            <button
              type="button"
              className={styles.btn}
              data-testid="managed-runtime-retry"
              onClick={() => onRetry(view.failedRequest!)}
            >
              {t('ui.chat-settings.managed-retry-request')}
            </button>
          )}
          {canAbandon && !hasPendingSwitch && (
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
