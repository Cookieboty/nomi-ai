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
    title={plan?.mode === 'install' ? t('安装 {0}', name) : t('更新 {0}', name)}
    data-testid={`cli-version-dialog-${testKind}`}
    footer={
      <>
        <Button size="sm" onClick={onClose} data-testid="cli-version-cancel">
          {t('取消')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!plan || plan.blockers.length > 0}
          onClick={onConfirm}
          data-testid="cli-version-confirm"
        >
          {plan?.mode === 'install' ? t('确认安装') : t('确认更新')}
        </Button>
      </>
    }
  >
    {plan && (
      <div className={styles.planBody}>
        <span>{t('将在本机执行以下命令（不会使用 sudo / 管理员权限）：')}</span>
        <code className={styles.cmd} data-testid="cli-version-command">
          {plan.command}
        </code>
        {plan.requirements.length > 0 && (
          <ul className={styles.reqList} aria-label={t('前置检查')}>
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
            <span>{t('或者改装到你的用户目录（不需要管理员权限）：')}</span>
            <code className={styles.cmd}>{plan.userScopeCommand}</code>
            <div>
              <Button size="sm" data-testid="cli-version-user-scope" onClick={onUserScope}>
                {t('改用用户目录安装')}
              </Button>
            </div>
          </div>
        )}
      </div>
    )}
  </Modal>
);
