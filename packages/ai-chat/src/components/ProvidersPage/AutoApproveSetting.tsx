/**
 * 设置 →「编程助手」：「全部自动（最高权限）」开关（默认开）。
 * 开着时新的编程助手标签与 Nomi 委派的编程助手默认「完全放开」，Nomi 对话工作区里的文件操作不再逐项确认；
 * 关掉后回到逐项询问。Nomi 的文件工具在任何档位都拒绝工作区外未授权的路径与敏感文件（.ssh、钥匙串、.env、应用数据…）；
 * Nomi 跑的命令（workspace_run）不受工作区限制，始终逐条确认。
 */
import { SettingRow, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { harnessClient } from '../../services/harnessClient';
import { confirmDialog } from '../ConfirmDialog';

import styles from './index.module.css';

export const AutoApproveSetting: React.FC = () => {
  const tabs = useHarnessTabs();
  const [pending, setPending] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const current = tabs.state?.autoApprove;
  // 主进程 tabsChanged 把 autoApprove 推到与 pending 一致后再清乐观态；
  // 不要在 current 仍是旧值时清掉，否则开关会弹回 true（测试里若不 emit 也会挂）
  useEffect(() => {
    if (pending === null || current !== pending) return;
    // 同步外部权威状态到乐观态：豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending(null);
  }, [current, pending]);
  if (!tabs.available || !tabs.state) return null;
  const on = pending ?? tabs.state.autoApprove !== false;

  const change = async (next: boolean) => {
    // 打开 = 放开权限：先确认一次（关掉是收紧，不用确认）
    if (
      next &&
      !(await confirmDialog({
        title: t('ui.chat-settings.turn-on-auto-approve'),
        message: t('ui.chat-settings.auto-approve-confirm-body'),
        confirmLabel: t('ui.knowledge-local.turn-on'),
        danger: true,
      }))
    )
      return;
    setPending(next);
    setErr(null);
    try {
      await harnessClient.setPermissionDefaults({ autoApprove: next });
    } catch (e) {
      setPending(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <SettingsGroup title={t('ui.chat-settings.permissions')}>
      <SettingRow
        title={t('ui.chat-settings.auto-approve-everything')}
        description={t('ui.chat-settings.auto-approve-description')}
      >
        <Switch
          checked={on}
          onChange={(v) => void change(v)}
          aria-label={t('ui.chat-settings.auto-approve-everything')}
          data-testid="auto-approve"
        />
      </SettingRow>
      {err && <p className={styles.sub}>{err}</p>}
    </SettingsGroup>
  );
};
