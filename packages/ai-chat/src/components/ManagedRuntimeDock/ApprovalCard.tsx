import { t } from '@nomi-ai/ui';
import React, { useLayoutEffect, useRef, useState } from 'react';

import styles from './index.module.css';
import type { ApprovalDetailView } from './types';

function isRejectKind(kind?: string): boolean {
  if (!kind) return false;
  const k = kind.toLowerCase();
  return k.includes('reject') || k.includes('deny');
}

function fallbackOptionName(kind?: string): string {
  switch (kind?.toLowerCase()) {
    case 'allow_once':
      return t('ui.usage-tools.allow-once');
    case 'allow_always':
      return t('ui.chat-settings.sandbox-allow-always');
    case 'reject_once':
      return t('ui.usage-tools.reject-once');
    case 'reject_always':
      return t('ui.usage-tools.reject-always');
    default:
      return isRejectKind(kind) ? t('ui.chat-settings.deny') : t('ui.chat-settings.allow');
  }
}

function needsPreviewExpand(text: string): boolean {
  if (!text) return false;
  return text.length > 140 || text.split('\n').length > 3;
}

const ApprovalItemRow: React.FC<{
  item: ApprovalDetailView;
  disabled?: boolean;
  onApprove: (approvalId: string, allow: boolean, optionId?: string) => void;
}> = ({ item, disabled, onApprove }) => {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const summaryText = item.summary?.trim() || '';
  const toolText = item.tool?.trim() || '';
  const showSummary = Boolean(summaryText && summaryText !== toolText);
  const argsText = item.argsPreview?.trim() || '';
  const showArgs = Boolean(argsText && argsText !== summaryText);
  const combinedText = [showSummary ? summaryText : '', showArgs ? argsText : '']
    .filter(Boolean)
    .join('\n');
  const heuristicLong = needsPreviewExpand(combinedText);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    setOverflows(el.scrollHeight > el.clientHeight + 2);
  }, [combinedText, expanded]);

  const canToggleExpand = expanded || overflows || heuristicLong;

  return (
    <div className={styles.approvalItem} data-testid={`managed-approval-item-${item.id}`}>
      <div className={styles.approvalHead}>
        <span className={styles.approvalTool} title={item.tool || item.id}>
          {item.tool || item.id}
        </span>
        {item.danger && <span className={styles.badge}>{item.danger}</span>}
      </div>
      {item.risk && (
        <p className={styles.note}>
          {t('ui.chat-settings.managed-approval-risk', item.risk)}
          {item.rationale ? ` · ${item.rationale}` : ''}
        </p>
      )}
      {(showSummary || showArgs) && (
        <div
          ref={bodyRef}
          data-testid={`managed-approval-preview-${item.id}`}
          data-expanded={expanded}
          className={`${styles.approvalPreview} ${
            expanded ? styles.approvalPreviewExpanded : styles.approvalPreviewCollapsed
          }`}
        >
          {showSummary && <pre className={styles.approvalText}>{summaryText}</pre>}
          {showArgs && (
            <div className={styles.approvalArgsBlock}>
              {showSummary && (
                <span className={styles.approvalArgsLabel}>
                  {t('ui.chat-settings.managed-approval-args')}
                </span>
              )}
              <pre className={styles.approvalText}>{argsText}</pre>
            </div>
          )}
          {!expanded && canToggleExpand && <div className={styles.approvalFade} aria-hidden />}
        </div>
      )}
      <div className={`${styles.actions} ${styles.approvalActions}`}>
        {canToggleExpand && (
          <button
            type="button"
            className={styles.expandToggle}
            data-testid={`managed-approval-expand-${item.id}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? t('ui.chat-settings.collapse-full') : t('ui.chat-settings.expand-full')}
          </button>
        )}
        {item.options && item.options.length > 0 ? (
          item.options.map((opt) => {
            const reject = isRejectKind(opt.kind);
            return (
              <button
                key={opt.id}
                type="button"
                className={reject ? styles.btn : styles.btnPrimary}
                data-testid={`managed-approval-option-${item.id}-${opt.id}`}
                disabled={disabled}
                onClick={() => onApprove(item.id, !reject, opt.id)}
              >
                {opt.name?.trim() || fallbackOptionName(opt.kind)}
              </button>
            );
          })
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
};

export const ApprovalCard: React.FC<{
  approvals: ApprovalDetailView[];
  disabled?: boolean;
  onApprove: (approvalId: string, allow: boolean, optionId?: string) => void;
}> = ({ approvals, disabled, onApprove }) => {
  if (!approvals.length) return null;
  return (
    <div className={styles.approvalCard} data-testid="managed-approval-card">
      <p className={styles.sectionLabel}>
        {t('ui.chat-settings.managed-approval-title', approvals.length)}
      </p>
      {approvals.map((item) => (
        <ApprovalItemRow key={item.id} item={item} disabled={disabled} onApprove={onApprove} />
      ))}
    </div>
  );
};
