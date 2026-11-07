/**
 * 沙箱挡下的授权请求（编程助手标签）：CLI 读了敏感位置或写了项目外的地方，被 Nomi 的系统沙箱拦下。
 * 本会话允许 / 始终允许后，内核重开这个标签的 CLI（续接会话）并发一条「请继续」；不允许的这个会话不再问。
 * 受保护的文件夹不能在这里放开，只提示去设置里取消保护。挂在标签状态上，一轮结束后也还在。
 */
import { Icon, t } from '@nomi-ai/ui';
import { ShieldCheck } from 'lucide-react';
import React, { useCallback } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import {
  harnessClient,
  type SandboxChoice,
  type SandboxPendingItem,
} from '../../services/harnessClient';

import styles from './index.module.css';

/** 类别 → 名称 key（与内核 internal/core/cli/sandbox 的 Categories 对应） */
export const SANDBOX_CATEGORY_LABELS: Record<string, string> = {
  ssh: 'ui.chat-settings.sandbox-category-ssh',
  cloud: 'ui.chat-settings.sandbox-category-cloud',
  keys: 'ui.chat-settings.sandbox-category-keys',
  browser: 'ui.chat-settings.sandbox-category-browser',
  personal: 'ui.chat-settings.sandbox-category-personal',
  'secret-files': 'ui.chat-settings.sandbox-category-secret-files',
};

export function sandboxItemLabel(kind: string, value: string): string {
  if (kind === 'category') {
    const key = SANDBOX_CATEGORY_LABELS[value];
    return key ? t(key) : value;
  }
  return value;
}

function describe(p: SandboxPendingItem): string {
  switch (p.kind) {
    case 'category':
      return t(
        'ui.chat-settings.sandbox-blocked-category',
        sandboxItemLabel(p.kind, p.value),
        p.path,
      );
    case 'read':
      return t('ui.chat-settings.sandbox-blocked-read', p.path);
    case 'folder':
      return t('ui.chat-settings.sandbox-blocked-folder', p.value, p.path);
    case 'file':
      return t('ui.chat-settings.sandbox-blocked-file', p.path);
    default:
      return t('ui.chat-settings.sandbox-blocked-protected', p.path);
  }
}

export const SandboxRequests: React.FC<{
  items: readonly SandboxPendingItem[] | undefined;
  onReply: (id: string, choice: SandboxChoice) => void;
}> = ({ items, onReply }) => {
  if (!items?.length) return null;
  return (
    <div className={styles.permQueue} data-testid="conv-sandbox-requests">
      {items.map((p) => (
        <div
          key={p.id}
          className={styles.perm}
          role="alertdialog"
          aria-label={t('ui.chat-settings.sandbox-blocked-title')}
          data-testid="conv-sandbox-card"
        >
          <div className={styles.permHead}>
            <Icon icon={ShieldCheck} size={16} />
            <span className={styles.permTitle}>{t('ui.chat-settings.sandbox-blocked-title')}</span>
          </div>
          <div className={styles.permSummary}>{describe(p)}</div>
          <div className={styles.permActions}>
            {p.kind === 'protected' ? (
              <button
                type="button"
                className={styles.permDeny}
                data-testid="conv-sandbox-dismiss"
                onClick={() => onReply(p.id, 'deny')}
              >
                {t('ui.models.got-it')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={styles.permAllow}
                  data-testid="conv-sandbox-session"
                  onClick={() => onReply(p.id, 'session')}
                >
                  {t('ui.chat-settings.sandbox-allow-session')}
                </button>
                <button
                  type="button"
                  className={styles.permDeny}
                  data-testid="conv-sandbox-always"
                  onClick={() => onReply(p.id, 'always')}
                >
                  {p.kind === 'category' || p.kind === 'read'
                    ? t('ui.chat-settings.sandbox-allow-always-project')
                    : t('ui.chat-settings.sandbox-allow-always')}
                </button>
                <button
                  type="button"
                  className={styles.permDeny}
                  data-testid="conv-sandbox-deny"
                  onClick={() => onReply(p.id, 'deny')}
                >
                  {t('ui.chat-settings.sandbox-deny')}
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

/** 某个编程助手标签的沙箱授权卡片（订阅完整标签状态，只有它自己跟着重渲染） */
export const TabSandboxRequests: React.FC<{ tabId: string }> = ({ tabId }) => {
  const tabs = useHarnessTabs();
  const items = tabs.state?.tabs.find((x) => x.id === tabId)?.sandboxPending;
  const onReply = useCallback(
    (requestId: string, choice: SandboxChoice) =>
      void harnessClient.sandboxReply(tabId, requestId, choice).catch(() => undefined),
    [tabId],
  );
  return <SandboxRequests items={items} onReply={onReply} />;
};

/** 某个任务的编程助手标签上挂着的沙箱授权卡片（任务页用：按 delegation.taskId 找标签） */
export const TaskSandboxRequests: React.FC<{ taskId: string }> = ({ taskId }) => {
  const tabs = useHarnessTabs();
  const tab = tabs.state?.tabs.find(
    (x) => x.delegation?.taskId === taskId && x.sandboxPending?.length,
  );
  if (!tab) return null;
  return <TabSandboxRequests tabId={tab.id} />;
};
