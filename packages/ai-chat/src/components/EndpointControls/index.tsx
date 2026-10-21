/**
 * 端点相关的两组控件：
 *
 * - `EndpointControls`（输入栏左侧）：端点切换 + 编程助手的权限模式，只留发消息时要用的。
 * - `SessionControls`（对话区右上角）：工作目录、「带上前文」标记、供应商 / 账号。
 *   Nomi：Nomi 对话的模型切换（NomiModelSwitch，统一网关）；
 *   Claude Code / Codex / dsh / Grok / Gemini：这个标签的来源菜单（CliSourceMenu：官方账号 / 第三方模型），
 *   不显示 Nomi 对话的模型分配。
 * 普通模式只有 Nomi，不显示端点切换。
 */
import { Button, Icon, Modal, t } from '@nomi-ai/ui';
import { History, X } from 'lucide-react';
import React, { useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import { useHarnessState } from '../../hooks/useHarnessState';
import { isCliKind } from '../../services/cliSource';
import { gatewayClientAvailable } from '../../services/gatewayClient';
import { MAIN_TAB_ID, harnessClient } from '../../services/harnessClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { BackendSwitcher } from '../BackendSwitcher';
import { CliSourceMenu } from '../CliSourceMenu';
import { ModelControls } from '../ModelControls';
import { NomiModelSwitch } from '../NomiModelSwitch';
import { PermissionModeChip } from '../PermissionModeChip';
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
  /** CLI 标签的来源菜单里「打开模型设置」 */
  onOpenModels: () => void;
}> = ({ onManageNomi, onOpenModels }) => {
  const { tabs, harness, cli, tab } = useEndpoint();
  // 主对话标签切到 CLI 后端时，来源也按主进程里的那个标签走
  const srcTab =
    tab ?? tabs.state?.tabs.find((x) => x.id === MAIN_TAB_ID && x.backend === cli) ?? null;
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

  // cwd 是 CLI 会话身份的一部分：换目录一定开新会话。已有对话时让用户选是否把它带过去
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

  const nomiProviders = !cli && gatewayClientAvailable();
  if (!cli && !nomiProviders) return null;

  return (
    <div className={styles.session} data-testid="session-controls">
      {cli && tab?.carriedMessages ? (
        <span
          className={styles.carry}
          data-testid="cli-carry-chip"
          title={t('下一条消息会连同之前的 {0} 条对话一起发给新会话', String(tab.carriedMessages))}
        >
          <Icon icon={History} size={14} />
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
      {cli
        ? isCliKind(cli) && (
            <CliSourceMenu
              key={cli}
              backend={cli}
              tab={srcTab}
              hasMessages={hasSession || visibleMessages > 0}
              onOpenModels={onOpenModels}
            />
          )
        : nomiProviders && <NomiModelSwitch onManage={onManageNomi} />}
      {pending && (
        <Modal
          open
          onClose={() => setPendingCwd(null)}
          title={t('切换工作目录')}
          closeLabel={t('取消')}
          data-testid="cli-cwd-switch"
          footer={
            <div className={styles.actions}>
              <Button data-testid="cli-cwd-cancel" onClick={() => setPendingCwd(null)}>
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
              {t('换到')} <code className={styles.path}>{pending.next}</code>
            </p>
            <p className="cd-muted" data-testid="cli-cwd-switch-origin">
              {t('标签「{0}」', pending.title)} ·{' '}
              <code className={styles.path}>{pending.originCwd}</code>
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
