/**
 * 端点相关的两组控件：
 *
 * - `EndpointControls`（输入栏左侧）：端点切换 + 编程助手的权限模式，只留发消息时要用的。
 * - `SessionControls`（对话区右上角）：工作目录、「带上前文」标记、供应商 / 账号。
 *   Nomi：Nomi 自有供应商 / 模型切换（ProviderSwitcher）；
 *   Claude Code / Codex / dsh / Grok / Gemini：只显示该后端自己的档案（CliProviderChip），绝不出现 Nomi 供应商。
 * 普通模式只有 Nomi，不显示端点切换。
 */
import { Button, Icon, Modal, t } from '@nomi-ai/ui';
import { History, X } from 'lucide-react';
import React, { useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import { useHarnessState } from '../../hooks/useHarnessState';
import type { CliProviderKind } from '../../services/cliProviderClient';
import { MAIN_TAB_ID, harnessClient } from '../../services/harnessClient';
import { providerClientAvailable } from '../../services/providerClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { BackendSwitcher } from '../BackendSwitcher';
import { CliProviderChip } from '../CliProviderChip';
import { ModelControls } from '../ModelControls';
import { PermissionModeChip } from '../PermissionModeChip';
import { ProviderSwitcher } from '../ProviderSwitcher';
import { WorkspacePicker } from '../WorkspacePicker';

import styles from './index.module.css';

/** 换目录后新会话怎么开：带上当前对话作为前文 / 干净地开新会话 */
type SwitchMode = 'carry' | 'fresh';

/** 当前显示的是哪个端点，以及对应的 CLI 标签（Nomi 为 null） */
function useEndpoint() {
  const { isDev } = useChatMode();
  const tabs = useHarnessTabs();
  const harness = useHarnessState();
  const backend = tabs.isCliTab && tabs.activeTab ? tabs.activeTab.backend : harness?.backend;
  const cli = isDev && backend && backend !== 'nomi' ? backend : null;
  const tab = tabs.isCliTab ? tabs.activeTab : null;
  return { isDev, tabs, harness, cli, tab };
}

/** 输入栏：端点切换 + 权限模式 */
export const EndpointControls: React.FC = () => {
  const { isDev, tabs, cli, tab } = useEndpoint();
  // 主对话标签切到 CLI 后端时也有权限模式（主进程里它同样是一个标签）
  const modeTab = tab ?? tabs.state?.tabs.find((x) => x.id === MAIN_TAB_ID) ?? null;
  return (
    <>
      {isDev && <BackendSwitcher />}
      {cli && modeTab && (
        <>
          <ModelControls key={`model-${modeTab.backend}`} tab={modeTab} />
          <PermissionModeChip tab={modeTab} defaultMode={tabs.state?.defaultPermissionMode} />
        </>
      )}
    </>
  );
};

/** 对话区右上角：工作目录（CLI）、「带上前文」标记、供应商 / 账号 */
export const SessionControls: React.FC<{
  onManageNomi: () => void;
  onManageCli: (backend: CliProviderKind) => void;
}> = ({ onManageNomi, onManageCli }) => {
  const { tabs, harness, cli, tab } = useEndpoint();
  const cwd = tab ? tab.cwd : (harness?.cwd ?? '');
  const hasSession = tab ? !!tab.cliSessionId : !!harness?.cliSessionId;
  const running = tab ? tab.status === 'running' || tab.status === 'queued' : !!harness?.busy;
  const visibleMessages = (tabs.messages ?? []).filter((m) => !m.error && m.content.trim()).length;
  /** 等用户决定怎么换的目标目录 */
  const [pending, setPending] = useState<string | null>(null);

  const apply = async (next: string, mode: SwitchMode) => {
    const opts = { carry: mode === 'carry' };
    if (tab) await harnessClient.setTabCwd(tab.id, next, opts).catch(() => undefined);
    else await harnessClient.setCwd(next, opts).catch(() => undefined);
  };

  // cwd 是 CLI 会话身份的一部分：换目录一定开新会话。已有对话时让用户选是否把它带过去
  const changeCwd = async (next: string) => {
    if (next === cwd) return;
    if (hasSession || running || visibleMessages > 0) setPending(next);
    else await apply(next, 'fresh');
  };

  const choose = (mode: SwitchMode) => {
    const next = pending;
    setPending(null);
    if (next) void apply(next, mode);
  };

  const nomiProviders = !cli && providerClientAvailable();
  if (!cli && !nomiProviders) return null;

  return (
    <div className={styles.session} data-testid="session-controls">
      {cli && tab?.carriedMessages ? (
        <span
          className={styles.carry}
          data-testid="cli-carry-chip"
          title={t('下一条消息会连同之前的 {0} 条对话一起发给新会话', String(tab.carriedMessages))}
        >
          <Icon icon={History} size={13} />
          {t('带上前文 · {0} 条', String(tab.carriedMessages))}
          <button
            type="button"
            className={styles.carryX}
            aria-label={t('不带前文')}
            data-testid="cli-carry-clear"
            onClick={() => void harnessClient.clearTabCarry(tab.id).catch(() => undefined)}
          >
            <Icon icon={X} size={12} />
          </button>
        </span>
      ) : null}
      {cli && <WorkspacePicker value={cwd} onChange={changeCwd} testId="cli-workspace" />}
      {cli ? (
        <CliProviderChip backend={cli} onManage={() => onManageCli(cli)} />
      ) : (
        nomiProviders && <ProviderSwitcher onManage={onManageNomi} />
      )}
      {pending !== null && (
        <Modal
          open
          onClose={() => setPending(null)}
          title={t('切换工作目录')}
          closeLabel={t('取消')}
          data-testid="cli-cwd-switch"
          footer={
            <div className={styles.actions}>
              <Button data-testid="cli-cwd-cancel" onClick={() => setPending(null)}>
                {t('取消')}
              </Button>
              <Button data-testid="cli-cwd-fresh" onClick={() => choose('fresh')}>
                {t('开新会话')}
              </Button>
              <Button
                variant="primary"
                autoFocus
                disabled={visibleMessages === 0}
                data-testid="cli-cwd-carry"
                onClick={() => choose('carry')}
              >
                {t('带上当前对话')}
              </Button>
            </div>
          }
        >
          <div className={styles.body}>
            <p>
              {t('换到')} <code className={styles.path}>{pending}</code>
            </p>
            <p className="cd-muted">
              {t(
                '{0} 的会话和工作目录绑定，换目录后会开一个新会话。可以把当前对话作为前文带过去，让它接着做；也可以从头开始。',
                ENDPOINT_NAME[cli ?? 'claude'],
              )}
            </p>
            {running && (
              <p className="cd-muted">{t('正在运行的这一轮不会中断，会在原目录跑完。')}</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
};
