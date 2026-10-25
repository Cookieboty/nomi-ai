/**
 * 端点相关的两组控件：
 *
 * - `EndpointControls`（输入栏左侧）：模型（编程助手还有权限模式），只留发消息时要用的。
 *   端点在新建对话时选定，之后不在输入栏切换。
 * - `WorkspaceControl`（对话顶栏右侧，挨着「改动 · 文件」开关）：工作目录与换目录确认。
 * - `SessionControls`（输入框左下角）：「带上前文」标记。
 *   编程助手的供应商在侧栏底部信息卡的「新标签默认」（CliDefaultSource）里设，模型在模型按钮里换。
 */
import { Button, Icon, Modal, t } from '@nomi-ai/ui';
import { History, X } from 'lucide-react';
import React, { useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import { useHarnessState } from '../../hooks/useHarnessState';
import { gatewayClientAvailable } from '../../services/gatewayClient';
import { MAIN_TAB_ID, harnessClient } from '../../services/harnessClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { ModelControls } from '../ModelControls';
import { NomiModelSwitch } from '../NomiModelSwitch';
import { BypassTip, PermissionModeChip, type PermissionTab } from '../PermissionModeChip';
import { WorkspacePicker } from '../WorkspacePicker';

import styles from './index.module.css';

/** 换目录后新会话怎么开：带上当前对话作为前文 / 干净地开新会话 */
type SwitchMode = 'carry' | 'fresh';

/** 等用户决定怎么换的目录切换：冻结发起时的标签（主对话标签为 null）、后端与原目录 */
interface PendingCwd {
  tabId: string | null;
  backend: string | null;
  title: string;
  originCwd: string;
  next: string;
}

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

/** 输入栏：模型 + 权限模式（Nomi 的模型走统一网关，与编程助手的模型按钮同位置） */
export const EndpointControls: React.FC = () => {
  const { tabs, harness, cli, tab } = useEndpoint();
  // 主对话标签切到 CLI 后端时也有权限模式（主进程里它同样是一个标签）
  const modeTab = tab ?? tabs.state?.tabs.find((x) => x.id === MAIN_TAB_ID) ?? null;
  // Nomi 对话（主标签）：权限模式作用在 Nomi 自己的工具上；主标签不在标签列表里，用 harness 状态
  // 等标签列表到了再判断：否则当前是 CLI 标签时会先闪一下 Nomi 的按钮
  const nomiTab: PermissionTab | null =
    tabs.state && !cli && harness?.backend === 'nomi'
      ? {
          id: MAIN_TAB_ID,
          backend: 'nomi',
          cwd: harness.cwd,
          title: '',
          permissionMode: harness.permissionMode,
        }
      : null;
  return (
    <>
      {!cli && gatewayClientAvailable() && <NomiModelSwitch />}
      {nomiTab && <PermissionModeChip tab={nomiTab} />}
      {cli && modeTab && (
        <>
          <ModelControls key={`model-${modeTab.backend}`} tab={modeTab} />
          <PermissionModeChip tab={modeTab} defaultMode={tabs.state?.defaultPermissionMode} />
        </>
      )}
    </>
  );
};

/** 输入框上方：「完全放开」提示条（只在 CLI 标签处于完全放开时出现） */
export const PermissionTip: React.FC = () => {
  const { tabs, cli, tab } = useEndpoint();
  const modeTab = tab ?? tabs.state?.tabs.find((x) => x.id === MAIN_TAB_ID) ?? null;
  if (!cli || !modeTab) return null;
  const def = tabs.state?.defaultPermissionMode;
  return <BypassTip tab={modeTab} exitMode={def && def !== 'bypass' ? def : 'acceptEdits'} />;
};

/** 当前 CLI 标签的工作目录与换目录流程（cwd 是 CLI 会话身份的一部分：换目录一定开新会话） */
function useCwdSwitch() {
  const { tabs, harness, cli, tab } = useEndpoint();
  const cwd = tab ? tab.cwd : (harness?.cwd ?? '');
  const hasSession = tab ? !!tab.cliSessionId : !!harness?.cliSessionId;
  const running = tab ? tab.status === 'running' || tab.status === 'queued' : !!harness?.busy;
  const visibleMessages = (tabs.messages ?? []).filter((m) => !m.error && m.content.trim()).length;
  const [pendingCwd, setPendingCwd] = useState<PendingCwd | null>(null);
  // 确认框打开期间换到了别的标签（Mod+数字、Ctrl+Tab、程序切换）、原标签被关闭或换了后端 / 目录：
  // 作废，绝不把对 A 的选择用到当前标签或主对话上（#68）。渲染期比对后清掉，切回 A 也不复活。
  const pending =
    pendingCwd &&
    pendingCwd.tabId === (tab?.id ?? null) &&
    pendingCwd.backend === cli &&
    pendingCwd.originCwd === cwd
      ? pendingCwd
      : null;
  if (pendingCwd && !pending) setPendingCwd(null);

  /** target：发起换目录时冻结的标签；没有 target 时就是当前标签 */
  const apply = async (next: string, mode: SwitchMode, target?: PendingCwd) => {
    const opts = { carry: mode === 'carry' };
    const tabId = target ? target.tabId : (tab?.id ?? null);
    if (tabId) await harnessClient.setTabCwd(tabId, next, opts).catch(() => undefined);
    else await harnessClient.setCwd(next, opts).catch(() => undefined);
  };

  // 已有对话时让用户选是否把它带过去
  const changeCwd = async (next: string) => {
    if (next === cwd) return;
    if (hasSession || running || visibleMessages > 0)
      setPendingCwd({
        tabId: tab?.id ?? null,
        backend: cli,
        title: tab?.title ?? (cli ? ENDPOINT_NAME[cli] : ''),
        originCwd: cwd,
        next,
      });
    else await apply(next, 'fresh');
  };

  const choose = (mode: SwitchMode) => {
    const target = pending;
    setPendingCwd(null);
    if (target) void apply(target.next, mode, target);
  };

  return {
    cli,
    cwd,
    changeCwd,
    modal: (
      <>
        {pending && (
          <Modal
            open
            onClose={() => setPendingCwd(null)}
            title={t('ui.chat-settings.switch-working-directory')}
            closeLabel={t('ui.foundation.cancel')}
            data-testid="cli-cwd-switch"
            footer={
              <div className={styles.actions}>
                <Button data-testid="cli-cwd-cancel" onClick={() => setPendingCwd(null)}>
                  {t('ui.foundation.cancel')}
                </Button>
                <Button data-testid="cli-cwd-fresh" onClick={() => choose('fresh')}>
                  {t('ui.chat-settings.start-a-new-session')}
                </Button>
                <Button
                  variant="primary"
                  autoFocus
                  disabled={visibleMessages === 0}
                  data-testid="cli-cwd-carry"
                  onClick={() => choose('carry')}
                >
                  {t('ui.chat-settings.bring-this-conversation')}
                </Button>
              </div>
            }
          >
            <div className={styles.body}>
              <p>
                {t('ui.chat-settings.switch-to')}{' '}
                <code className={styles.path}>{pending.next}</code>
              </p>
              <p className="cd-muted" data-testid="cli-cwd-switch-origin">
                {t('ui.chat-settings.tab', pending.title)} ·{' '}
                <code className={styles.path}>{pending.originCwd}</code>
              </p>
              <p className="cd-muted">
                {t(
                  'ui.chat-settings.sessions-are-tied-to-their-working-directory-so',
                  ENDPOINT_NAME[cli ?? 'claude'],
                )}
              </p>
              {running && (
                <p className="cd-muted">
                  {t('ui.chat-settings.the-turn-that-is-running-won-t-be')}
                </p>
              )}
            </div>
          </Modal>
        )}
      </>
    ),
  };
}

/** 对话顶栏右侧：当前标签的工作目录（与「改动 · 文件」开关相邻，说的都是这个目录；分支在右栏顶部） */
export const WorkspaceControl: React.FC = () => {
  const { cli, cwd, changeCwd, modal } = useCwdSwitch();
  if (!cli) return null;
  return (
    <>
      <WorkspacePicker
        value={cwd}
        onChange={changeCwd}
        size="ms"
        variant="ghost"
        testId="cli-workspace"
      />
      {modal}
    </>
  );
};

/**
 * 输入框左下角：「带上前文」标记（换目录 / 换来源后才有）。
 * 编程助手的供应商在侧栏底部信息卡的「新标签默认」里设，已有会话用 `/model` 单独换。
 */
export const SessionControls: React.FC = () => {
  const { cli, tab } = useEndpoint();
  const carry = cli && tab?.carriedMessages ? tab : null;
  if (!carry) return null;

  return (
    <div className={styles.session} data-testid="session-controls">
      <span
        className={styles.carry}
        data-testid="cli-carry-chip"
        title={t(
          'ui.chat-settings.your-next-message-will-be-sent-to-the',
          String(carry.carriedMessages),
        )}
      >
        <Icon icon={History} size={14} />
        {t('ui.chat-settings.with-context', String(carry.carriedMessages))}
        <button
          type="button"
          className={styles.carryX}
          aria-label={t('ui.chat-settings.don-t-bring-the-context')}
          data-testid="cli-carry-clear"
          onClick={() => void harnessClient.clearTabCarry(carry.id).catch(() => undefined)}
        >
          <Icon icon={X} size={12} />
        </button>
      </span>
    </div>
  );
};
