/**
 * 设置 →「编程助手」：「全部自动（最高权限）」开关（默认开）。
 * 只管编程助手：开着时新的编程助手标签与 Nomi 委派的编程助手默认「完全放开」；关掉后新标签用默认档位。
 * Nomi 自己的权限（工作区文件操作免确认、命令自动审核）在设置 →「Nomi」→ 权限，与这里分开。
 * 「允许 Codex 联网」（默认关）：沙箱里的命令能不能直接联网；关着时 Codex 要联网会先发审批。
 */
import { SettingRow, Switch, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { harnessClient } from '../../services/harnessClient';
import { confirmDialog } from '../ConfirmDialog';

import styles from './index.module.css';

export const AutoApproveSetting: React.FC = () => {
  const tabs = useHarnessTabs();
  const [pending, setPending] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [netPending, setNetPending] = useState<boolean | null>(null);
  const current = tabs.state?.autoApprove;
  const netCurrent = tabs.state?.codexNetwork;
  useEffect(() => {
    if (netPending === null || netCurrent !== netPending) return;
    // 同步外部权威状态到乐观态：豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNetPending(null);
  }, [netCurrent, netPending]);
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
  const network = netPending ?? tabs.state.codexNetwork === true;

  const changeNetwork = async (next: boolean) => {
    setNetPending(next);
    setErr(null);
    try {
      await harnessClient.setPermissionDefaults({ codexNetwork: next });
    } catch (e) {
      setNetPending(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

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
    <details className={styles.fold} data-testid="auto-approve-fold">
      <summary className={styles.foldSummary}>{t('ui.chat-settings.permissions')}</summary>
      <SettingRow
        title={t('ui.chat-settings.auto-approve-everything')}
        description={t('ui.chat-settings.auto-approve-coding-description')}
      >
        <Switch
          checked={on}
          onChange={(v) => void change(v)}
          aria-label={t('ui.chat-settings.auto-approve-everything')}
          data-testid="auto-approve"
        />
      </SettingRow>
      <SettingRow
        title={t('ui.chat-settings.codex-network')}
        description={t('ui.chat-settings.codex-network-description')}
      >
        <Switch
          checked={network}
          onChange={(v) => void changeNetwork(v)}
          aria-label={t('ui.chat-settings.codex-network')}
          data-testid="codex-network"
        />
      </SettingRow>
      {err && <p className={styles.sub}>{err}</p>}
    </details>
  );
};
