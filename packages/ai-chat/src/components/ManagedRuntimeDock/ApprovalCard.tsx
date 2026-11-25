import { t } from '@nomi-ai/ui';
import React from 'react';

import styles from './index.module.css';
import type { ApprovalDetailView } from './types';

export const ApprovalCard: React.FC<{
  approvals: ApprovalDetailView[];
  disabled?: boolean;
  onApprove: (approvalId: string, allow: boolean) => void;
}> = ({ approvals, disabled, onApprove }) => {
  if (!approvals.length) return null;
  return (
    <div className={styles.approvalCard} data-testid="managed-approval-card">
      <p className={styles.sectionLabel}>
        {t('ui.chat-settings.managed-approval-title', approvals.length)}
      </p>
      {approvals.map((item) => (
        <div
          key={item.id}
          className={styles.approvalItem}
          data-testid={`managed-approval-item-${item.id}`}
        >
          <div className={styles.approvalHead}>
            <span className={styles.approvalTool}>{item.tool || item.id}</span>
            {item.danger && <span className={styles.badge}>{item.danger}</span>}
          </div>
          {item.summary && item.summary !== item.tool && (
            <p className={styles.note}>{item.summary}</p>
          )}
          {item.risk && (
            <p className={styles.note}>
              {t('ui.chat-settings.managed-approval-risk', item.risk)}
              {item.rationale ? ` · ${item.rationale}` : ''}
            </p>
          )}
          {item.argsPreview && (
            <details className={styles.details}>
              <summary className={styles.summary}>
                {t('ui.chat-settings.managed-approval-args')}
              </summary>
              <pre className={styles.code}>{item.argsPreview}</pre>
            </details>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.btnPrimary}
              data-testid={`managed-approval-allow-${item.id}`}
              disabled={disabled}
              onClick={() => onApprove(item.id, true)}
            >
              {t('ui.chat-settings.allow')}
            </button>
            <button
              type="button"
              className={styles.btn}
              data-testid={`managed-approval-deny-${item.id}`}
              disabled={disabled}
              onClick={() => onApprove(item.id, false)}
            >
              {t('ui.chat-settings.deny')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
