/**
 * 设置 →「Nomi」→ 权限：Nomi 自己做事要不要先问你（与编程助手的设置分开）。
 * - 工作区文件操作免确认：Nomi 对话选了工作区时，工作区里的文件读写不再逐项确认；没单独设过时跟随
 *   编程助手的「全部自动」（老用户行为不变）。工作区外未授权的路径与敏感文件照旧拒绝。
 * - 命令自动审核：Nomi 跑命令（workspace_run）前先让辅助模型判风险，低风险直接执行，其余交给你确认。
 */
import { SettingRow, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { harnessClient, type HarnessTabsState } from '../../services/harnessClient';
import { confirmDialog } from '../ConfirmDialog';

import styles from './index.module.css';

type Key = 'nomiAutoApprove' | 'aiReview';

/** 一个权限默认值的开关：乐观更新，内核推回一致的状态后再清掉临时值 */
function usePermissionSwitch(key: Key, read: (s: HarnessTabsState) => boolean) {
  const tabs = useHarnessTabs();
  const [pending, setPending] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const current = tabs.state ? read(tabs.state) : undefined;
  useEffect(() => {
    if (pending === null || current !== pending) return;
    // 同步外部权威状态到乐观态：豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending(null);
  }, [current, pending]);
  const change = async (next: boolean) => {
    setPending(next);
    setErr(null);
    try {
      await harnessClient.setPermissionDefaults({ [key]: next });
    } catch (e) {
      setPending(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return { on: pending ?? current ?? false, change, err };
}

export const NomiPermissionSettings: React.FC = () => {
  const tabs = useHarnessTabs();
  // 没单独设过时跟随「全部自动」
  const files = usePermissionSwitch(
    'nomiAutoApprove',
    (s) => s.nomiAutoApprove ?? s.autoApprove !== false,
  );
  // 缺省 = 开（内核只在关掉时带 aiReview: false）
  const review = usePermissionSwitch('aiReview', (s) => s.aiReview !== false);
  if (!tabs.available || !tabs.state) return null;
  const err = files.err ?? review.err;
  // 打开 = 放开权限：先确认一次（关掉是收紧，不用确认）
  const enableFiles = async (next: boolean) => {
    if (
      next &&
      !(await confirmDialog({
        title: t('ui.chat-settings.nomi-auto-approve-confirm-title'),
        message: t('ui.chat-settings.nomi-auto-approve-confirm-body'),
        confirmLabel: t('ui.knowledge-local.turn-on'),
        danger: true,
      }))
    )
      return;
    await files.change(next);
  };
  return (
    <div className={styles.groups} data-testid="settings-nomi-permissions">
      <SettingsGroup title={t('ui.chat-settings.permissions')}>
        <SettingRow
          title={t('ui.chat-settings.nomi-workspace-auto-approve')}
          description={t('ui.chat-settings.nomi-workspace-auto-approve-description')}
        >
          <Switch
            checked={files.on}
            onChange={(v) => void enableFiles(v)}
            aria-label={t('ui.chat-settings.nomi-workspace-auto-approve')}
            data-testid="nomi-auto-approve"
          />
        </SettingRow>
        <SettingRow
          title={t('ui.chat-settings.ai-review-commands')}
          description={t('ui.chat-settings.ai-review-commands-description')}
        >
          <Switch
            checked={review.on}
            onChange={(v) => void review.change(v)}
            aria-label={t('ui.chat-settings.ai-review-commands')}
            data-testid="ai-review"
          />
        </SettingRow>
      </SettingsGroup>
      {err && <p className={styles.note}>{err}</p>}
    </div>
  );
};
