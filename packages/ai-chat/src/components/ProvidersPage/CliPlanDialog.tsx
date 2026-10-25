/**
 * 安装 / 更新编程助手前的确认框：展示确切命令与前置检查（Node / npm / 写权限）；
 * 有阻塞原因时不能确认；没有写权限时可改用用户目录安装。
 * 「编程助手」页的版本卡片和「模型」页的 CLI 行共用（命令由主进程 cliUpdateClient.preview 给出）。
 */
import { Button, Icon, Modal, Notice, t } from '@nomi-ai/ui';
import { CircleCheck, CircleX } from 'lucide-react';
import React from 'react';

import type { CliInstallPlan } from '../../services/cliUpdateClient';

import styles from './index.module.css';

export const CliPlanDialog: React.FC<{
  plan: CliInstallPlan | null;
  /** 端点显示名 */
  name: string;
  /** data-testid 后缀（端点 kind） */
  testKind: string;
  onClose: () => void;
  onConfirm: () => void;
  onUserScope: () => void;
}> = ({ plan, name, testKind, onClose, onConfirm, onUserScope }) => (
  <Modal
    open={Boolean(plan)}
    onClose={onClose}
    title={
      plan?.mode === 'install'
        ? t('ui.cli-monitor.install-710b3a', name)
        : t('ui.cli-monitor.update', name)
    }
    data-testid={`cli-version-dialog-${testKind}`}
    footer={
      <>
        <Button size="sm" onClick={onClose} data-testid="cli-version-cancel">
          {t('ui.foundation.cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!plan || plan.blockers.length > 0}
          onClick={onConfirm}
          data-testid="cli-version-confirm"
        >
          {plan?.mode === 'install'
            ? t('ui.mascot-theme.install-now')
            : t('ui.cli-monitor.confirm-update')}
        </Button>
      </>
    }
  >
    {plan && (
      <div className={styles.planBody}>
        <span>{t('ui.cli-monitor.this-command-will-run-on-this-machine-no')}</span>
        <code className={styles.cmd} data-testid="cli-version-command">
          {plan.command}
        </code>
        {plan.requirements.length > 0 && (
          <ul className={styles.reqList} aria-label={t('ui.cli-monitor.requirements')}>
            {plan.requirements.map((r) => (
              <li
                key={r.id}
                className={r.ok ? styles.reqOk : styles.reqBad}
                data-testid={`cli-version-req-${r.id}`}
                data-ok={r.ok ? '1' : '0'}
              >
                <Icon icon={r.ok ? CircleCheck : CircleX} size={14} className={styles.reqIcon} />
                {r.label} — {r.detail}
              </li>
            ))}
          </ul>
        )}
        {plan.blockers.map((b) => (
          <Notice key={b} tone="danger" data-testid="cli-version-blocker">
            {b}
          </Notice>
        ))}
        {plan.userScopeCommand && plan.scope === 'global' && (
          <div className={styles.planUserScope}>
            <span>{t('ui.cli-monitor.or-install-into-your-user-directory-instead-no')}</span>
            <code className={styles.cmd}>{plan.userScopeCommand}</code>
            <div>
              <Button size="sm" data-testid="cli-version-user-scope" onClick={onUserScope}>
                {t('ui.cli-monitor.install-to-user-directory')}
              </Button>
            </div>
          </div>
        )}
      </div>
    )}
  </Modal>
);
