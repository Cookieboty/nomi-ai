/** PR3：退出计划模式 → 「批准计划」三选一卡片（docs/design/cli-permission-modes.md §5） */
import { Icon, t } from '@nomi-ai/ui';
import { ClipboardCheck } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import styles from './index.module.css';

export type ApprovePlanChoice = 'acceptEdits' | 'manual' | 'deny';

/** 剩余秒数（每秒刷新）；没有截止时间返回 null */
function useSecondsLeft(expiresAt: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  return expiresAt === undefined ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/**
 * 批准计划：批准并自动改文件 / 批准并逐项确认 / 继续修改。
 * Codex/dsh/Grok 的「按此方案执行」也走此卡（toolName=execute_plan）。
 */
export const ApprovePlanCard: React.FC<{
  summary: string;
  agent?: string;
  expiresAt?: number;
  /** execute_plan 时主按钮文案用「按此方案执行」 */
  executePlan?: boolean;
  onChoice: (choice: ApprovePlanChoice) => void;
}> = ({ summary, agent, expiresAt, executePlan, onChoice }) => {
  const left = useSecondsLeft(expiresAt);
  const title = executePlan
    ? t('ui.chat-settings.execute-this-plan')
    : t('ui.chat-settings.approve-plan');
  return (
    <div
      className={styles.perm}
      data-testid="conv-approve-plan-card"
      role="alertdialog"
      aria-label={title}
    >
      <div className={styles.permHead}>
        <Icon icon={ClipboardCheck} size={16} />
        <span className={styles.permTitle}>{title}</span>
        {agent && (
          <span className={styles.permSource} data-testid="conv-approve-plan-agent">
            {t('ui.chat-settings.subagent', agent)}
          </span>
        )}
        {left !== null && (
          <span className={styles.permTimer} data-testid="conv-approve-plan-timer">
            {t('ui.chat-settings.auto-deny-in-s', String(left))}
          </span>
        )}
      </div>
      <code className={styles.permSummary}>{summary}</code>
      <div className={styles.permActions}>
        <button
          type="button"
          className={styles.permAllow}
          data-testid="conv-approve-plan-accept-edits"
          onClick={() => onChoice('acceptEdits')}
        >
          {executePlan
            ? t('ui.chat-settings.execute-this-plan')
            : t('ui.chat-settings.approve-and-auto-edit')}
        </button>
        {!executePlan && (
          <button
            type="button"
            className={styles.permAllow}
            data-testid="conv-approve-plan-manual"
            onClick={() => onChoice('manual')}
          >
            {t('ui.chat-settings.approve-with-step-by-step-confirm')}
          </button>
        )}
        <button
          type="button"
          className={styles.permDeny}
          data-testid="conv-approve-plan-deny"
          onClick={() => onChoice('deny')}
        >
          {t('ui.chat-settings.keep-editing')}
        </button>
      </div>
    </div>
  );
};
