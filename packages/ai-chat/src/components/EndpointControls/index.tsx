/**
 * 输入栏左侧「端点控制组」：端点（后端）+ 该端点自己的供应商 / 模型。
 *
 * - Nomi：Nomi 自有供应商 / 模型切换（ProviderSwitcher）。
 * - Claude Code / Codex / dsh：只显示该后端自己的档案（CliProviderChip），绝不出现 Nomi 供应商。
 * 普通模式只有 Nomi，不显示端点切换。
 */
import { t } from '@nomi-ai/ui';
import React from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import { useHarnessState } from '../../hooks/useHarnessState';
import { harnessClient } from '../../services/harnessClient';
import { providerClientAvailable } from '../../services/providerClient';
import { BackendSwitcher } from '../BackendSwitcher';
import { CliProviderChip } from '../CliProviderChip';
import { ProviderSwitcher } from '../ProviderSwitcher';
import { WorkspacePicker } from '../WorkspacePicker';

export const EndpointControls: React.FC<{
  className?: string;
  onManageNomi: () => void;
  onManageCli: (backend: 'claude' | 'codex' | 'dsh' | 'grok') => void;
}> = ({ className, onManageNomi, onManageCli }) => {
  const { isDev } = useChatMode();
  const tabs = useHarnessTabs();
  const harness = useHarnessState();
  const backend = tabs.isCliTab && tabs.activeTab ? tabs.activeTab.backend : harness?.backend;
  const cli = isDev && backend && backend !== 'nomi' ? backend : null;
  const tab = tabs.isCliTab ? tabs.activeTab : null;
  const cwd = tab ? tab.cwd : (harness?.cwd ?? '');
  const hasSession = tab ? !!tab.cliSessionId : !!harness?.cliSessionId;
  const running = tab ? tab.status === 'running' || tab.status === 'queued' : !!harness?.busy;

  // cwd 是会话身份的一部分：已有会话 / 正在运行时更换目录会开启新的 CLI 会话
  const changeCwd = async (next: string) => {
    if (
      (hasSession || running) &&
      !window.confirm(
        t(
          '更改工作目录会开启新的 CLI 会话：当前会话的上下文不会带过去，正在运行的轮次也不会中断。继续？',
        ),
      )
    )
      return;
    if (tab) await harnessClient.setTabCwd(tab.id, next).catch(() => undefined);
    else await harnessClient.setCwd(next).catch(() => undefined);
  };

  return (
    <>
      {isDev && <BackendSwitcher />}
      {cli && <WorkspacePicker up value={cwd} onChange={changeCwd} testId="cli-workspace" />}
      {cli ? (
        <CliProviderChip backend={cli} className={className} onManage={() => onManageCli(cli)} />
      ) : (
        providerClientAvailable() && (
          <ProviderSwitcher className={className} onManage={onManageNomi} />
        )
      )}
    </>
  );
};
