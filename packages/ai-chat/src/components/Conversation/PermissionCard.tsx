/** 权限请求卡片：agent 标签的审批队列和 Nomi 派出的子任务卡片共用（注明来源子代理与自动拒绝倒计时） */
import { Icon, t } from '@nomi-ai/ui';
import { IconShieldExclamation as ShieldAlert } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';

import type { AcpPermissionOption } from '../../services/harnessClient';

import styles from './index.module.css';

function isRejectOption(kind?: string): boolean {
  if (!kind) return false;
  const k = kind.toLowerCase();
  return k.includes('reject') || k.includes('deny');
}

function optionFallbackLabel(kind?: string): string {
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
      return isRejectOption(kind) ? t('ui.chat-settings.deny') : t('ui.chat-settings.allow');
  }
}

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

/** 权限请求：醒目卡片（注明来源子代理与自动拒绝倒计时） */
export const PermissionCard: React.FC<{
  summary: string;
  agent?: string;
  expiresAt?: number;
  options?: AcpPermissionOption[];
  onReply: (allow: boolean, optionId?: string) => void;
}> = ({ summary, agent, expiresAt, options, onReply }) => {
  const left = useSecondsLeft(expiresAt);
  return (
    <div
      className={styles.perm}
      data-testid="conv-permission-card"
      role="alertdialog"
      aria-label={
        agent
          ? t('ui.chat-settings.subagent-needs-permission-for-a-tool', agent)
          : t('ui.cli-monitor.tool-permission-required')
      }
    >
      <div className={styles.permHead}>
        <Icon icon={ShieldAlert} size={16} />
        <span className={styles.permTitle}>{t('ui.cli-monitor.tool-permission-required')}</span>
        {agent && (
          <span className={styles.permSource} data-testid="conv-permission-agent">
            {t('ui.chat-settings.subagent', agent)}
          </span>
        )}
        {left !== null && (
          <span className={styles.permTimer} data-testid="conv-permission-timer">
            {t('ui.chat-settings.auto-deny-in-s', String(left))}
          </span>
        )}
      </div>
      <code className={styles.permSummary}>{summary}</code>
      <div className={styles.permActions}>
        {options && options.length > 0 ? (
          options.map((opt) => {
            const reject = isRejectOption(opt.kind);
            return (
              <button
                key={opt.id}
                type="button"
                className={reject ? styles.permDeny : styles.permAllow}
                data-testid={`conv-permission-option-${opt.id}`}
                onClick={() => onReply(!reject, opt.id)}
              >
                {opt.name?.trim() || optionFallbackLabel(opt.kind)}
              </button>
            );
          })
        ) : (
          <>
            <button
              type="button"
              className={styles.permAllow}
              data-testid="conv-permission-allow"
              onClick={() => onReply(true)}
            >
              {t('ui.chat-settings.allow')}
            </button>
            <button
              type="button"
              className={styles.permDeny}
              data-testid="conv-permission-deny"
              onClick={() => onReply(false)}
            >
              {t('ui.chat-settings.deny')}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
