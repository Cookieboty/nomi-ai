import { cliFullName, isBuiltinCliId } from '@nomi-ai/cli-catalog';
import { Icon, t } from '@nomi-ai/ui';
import { IconX as X } from '@tabler/icons-react';
import React from 'react';

import { ApprovalCard } from './ApprovalCard';
import styles from './index.module.css';
import { RecoveryBanner } from './RecoveryBanner';
import { backendLabelKey, type ManagedRuntimeView } from './types';

export type {
  ApprovalDetailView,
  CapabilityBridgesView,
  FailedRequestView,
  ManagedRuntimeView,
  ManagedSwitchInput,
  RuntimeChoiceView,
  TraceEntryView,
} from './types';

export const backendName = (id: string): string => {
  const key = backendLabelKey(id);
  if (key) return t(key);
  if (isBuiltinCliId(id)) return cliFullName(id);
  return id || t('ui.chat-settings.managed-backend-claude');
};

function hasRecoveryBanner(view: ManagedRuntimeView): boolean {
  if (!view.managed) return false;
  return Boolean(view.pendingSwitch || (view.phase === 'uncertain' && view.recovery === 'unknown'));
}

export const ManagedRuntimePanel: React.FC<{
  view: ManagedRuntimeView;
  onResolve: (decision?: 'new-native' | 'rollback-switch') => void;
  onApprove?: (approvalId: string, allow: boolean) => void;
  onDismissError?: () => void;
}> = ({ view, onResolve, onApprove, onDismissError }) => {
  const activeName = backendName(view.backend || '');
  const unknown = view.managed && view.phase === 'uncertain' && view.recovery === 'unknown';
  const hasApprovals = Boolean(
    onApprove && view.approvalDetails && view.approvalDetails.length > 0,
  );
  const showRecovery = hasRecoveryBanner(view);
  const showUnknownGuidance = unknown && !view.pendingSwitch;

  if (!hasApprovals && !showRecovery && !view.error) {
    return null;
  }

  return (
    <section
      className={styles.dock}
      data-testid="managed-runtime-dock"
      aria-label={t('ui.chat-settings.managed-runtime-title')}
    >
      {showUnknownGuidance && (
        <p className={styles.guidance} data-testid="managed-runtime-guidance">
          {t('ui.chat-settings.managed-recovery-unknown', activeName)}
        </p>
      )}
      {view.error && (
        <div className={styles.errorRow}>
          <p className={styles.error} data-testid="managed-runtime-error">
            {view.error}
          </p>
          {onDismissError && (
            <button
              type="button"
              className={styles.dismissBtn}
              aria-label={t('ui.mascot-theme.dismiss')}
              data-testid="managed-runtime-error-dismiss"
              onClick={onDismissError}
            >
              <Icon icon={X} size={12} />
            </button>
          )}
        </div>
      )}
      <RecoveryBanner view={view} activeName={activeName} onResolve={onResolve} />
      {hasApprovals && onApprove && view.approvalDetails && (
        <ApprovalCard
          approvals={view.approvalDetails}
          disabled={view.phase !== 'running'}
          onApprove={onApprove}
        />
      )}
    </section>
  );
};
