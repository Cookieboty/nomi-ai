/**
 * 设置 → Computer Use：让 Nomi（和编程助手）操作本机应用。
 * 执行器 agent-desktop（npm 包，不随安装包分发）：安装 / 检查更新 / 更新、系统权限与授权引导、
 * 「允许编程助手使用」开关、紧急停止；视觉兜底 / 打码 / 禁止的应用 / 隔离模式在 ComputerOptions。
 * 内核 internal/core/computer（契约 computer.*）。
 */
import {
  Badge,
  Button,
  Disclosure,
  Notice,
  SettingRow,
  SettingsGroup,
  t,
  type BadgeTone,
} from '@nomi-ai/ui';
import { AlertTriangle, Info } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';

import { ComputerOptions } from './ComputerOptions';
import styles from './ComputerSection.module.css';
import base from './index.module.css';
import { SectionPage } from './SectionPage';
import { SECTION_TABS, type ComputerTab } from './sections';

export interface ComputerState {
  platform: string;
  installed: boolean;
  path: string;
  version: string;
  latest: string;
  updateAvailable: boolean;
  newerMajor: string;
  supportedMajor: number;
  unsupported: boolean;
  npmAvailable: boolean;
  installing: boolean;
  permissions: Record<string, string>;
  permissionApp: string;
  wayland: boolean;
  cliEnabled: boolean;
  autoApprove: boolean;
  active: string[];
  visionModel: string;
  visionModels: Array<{ ref: string; label: string; provider: string }>;
  blockedApps: string[];
  redact: boolean;
  sandbox: string;
  sandboxes: Array<{ name: string; state: string }>;
  sandboxSupported: boolean;
  stopShortcut: string;
  stopShortcutActive: string;
  stopShortcutError: string;
  defaultStopShortcut: string;
}

export type ComputerSettingsPatch = Partial<
  Pick<
    ComputerState,
    | 'cliEnabled'
    | 'autoApprove'
    | 'visionModel'
    | 'blockedApps'
    | 'redact'
    | 'sandbox'
    | 'stopShortcut'
  >
>;

interface InstallResult {
  ok: boolean;
  version: string;
  path: string;
  log: string;
  needsUserScope: boolean;
  userPrefix?: string;
}

const PERM_TONE: Record<string, BadgeTone> = {
  granted: 'success',
  not_required: 'neutral',
  denied: 'danger',
};

function permLabel(state: string | undefined): string {
  switch (state) {
    case 'granted':
      return t('ui.chat-settings.computer-perm-granted');
    case 'denied':
      return t('ui.chat-settings.computer-perm-denied');
    case 'not_required':
      return t('ui.chat-settings.computer-perm-not-required');
    default:
      return t('ui.chat-settings.computer-perm-unknown');
  }
}

export const ComputerSection: React.FC<{
  tab?: ComputerTab;
  onTab?: (tab: ComputerTab) => void;
}> = ({ tab, onTab }) => {
  // 设置页传入受控的标签；单独渲染（测试）时自己记
  const [ownTab, setOwnTab] = useState<ComputerTab>('setup');
  const cur = tab ?? ownTab;
  const setCur = onTab ?? setOwnTab;
  const [state, setState] = useState<ComputerState | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [checkedNow, setCheckedNow] = useState(false);

  const load = useCallback(async (refresh: boolean, fresh = false) => {
    if (!hasTransport()) return;
    const input: { refresh?: boolean; fresh?: boolean } = {};
    if (refresh) input.refresh = true;
    if (fresh) input.fresh = true;
    const s = (await api.computer.state(input)) as ComputerState;
    setState(s);
  }, []);

  useEffect(() => {
    if (!hasTransport()) return undefined;
    let alive = true;
    let focusTimer = 0;
    let inflight = false;
    let again = false;
    // 读状态。不带 fresh：几秒内内核复用上一次的 agent-desktop 结果。
    const pull = () => {
      if (!alive) return;
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      void api.computer
        .state({})
        .then((s) => {
          if (alive) setState(s as ComputerState);
        })
        .finally(() => {
          inflight = false;
          if (again && alive) {
            again = false;
            pull();
          }
        });
    };
    pull();
    // 从系统设置授权回来会重新聚焦。控制台窗口抢焦点时会连着触发，合并成一次，
    // 避免反复拉起 agent-desktop（再叠一层内核缓存）。
    const onFocus = () => {
      window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(() => {
        if (alive) pull();
      }, 500);
    };
    window.addEventListener('focus', onFocus);
    // 后台查到新版本等：重新读一次（打开页面时不等网络；版本缓存仍在，不会再启进程）
    const offChanged = api.on('computer.changed', () => {
      if (alive) pull();
    });
    // 谁在操作桌面：「停止」按钮跟着出现 / 消失
    const off = api.on('computer.activity', (e) => {
      if (alive) setState((s) => (s ? { ...s, active: e.active } : s));
    });
    return () => {
      alive = false;
      window.clearTimeout(focusTimer);
      off();
      offChanged();
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const check = async () => {
    setChecking(true);
    try {
      await load(true);
      setCheckedNow(true);
    } finally {
      setChecking(false);
    }
  };

  const install = async (scope?: 'global' | 'user') => {
    setInstalling(true);
    setResult(null);
    try {
      const r = (await api.computer.install(scope ? { scope } : {})) as InstallResult;
      // 成功就清掉日志；失败（含需要改装到用户目录）留着
      setResult(r.ok ? null : r);
      await load(false);
    } finally {
      setInstalling(false);
    }
  };

  const update = async (patch: ComputerSettingsPatch) => {
    setState((await api.computer.updateSettings(patch)) as ComputerState);
  };

  const stop = async () => {
    await api.computer.stop();
    setState((s) => (s ? { ...s, active: [] } : s));
  };

  const [rechecking, setRechecking] = useState(false);
  const recheck = async () => {
    setRechecking(true);
    try {
      await load(false, true);
    } finally {
      setRechecking(false);
    }
  };

  const openGuide = async () => {
    await api.computer.openGuide();
    window.setTimeout(() => void load(false, true), 1500);
  };

  if (!hasTransport()) {
    return <p className={base.note}>{t('ui.chat-settings.computer-unavailable-here')}</p>;
  }
  if (!state) return null;

  const busy = installing || state.installing;
  const mac = state.platform === 'darwin';
  const accessibility = state.permissions.accessibility;
  const screen = state.permissions.screen_recording;

  const statusText = state.installed
    ? t('ui.chat-settings.computer-installed-version').replace('{0}', state.version || '—')
    : t('ui.mascot-theme.not-installed');
  let updateText = '';
  if (state.installed && state.updateAvailable && state.latest) {
    updateText = t('ui.chat-settings.computer-update-available').replace('{0}', state.latest);
  } else if (state.installed && checkedNow && state.latest) {
    updateText = t('ui.mascot-theme.you-are-up-to-date');
  } else if (checkedNow && !state.latest) {
    updateText = t('ui.chat-settings.computer-check-failed');
  }

  return (
    <SectionPage
      testId="settings-computer-page"
      tabsLabel="ui.chat-settings.computer-section"
      tabs={SECTION_TABS.computer}
      value={cur}
      onChange={setCur}
    >
      {state.active.length > 0 ? (
        <Notice tone="warning" icon={AlertTriangle} data-testid="computer-active">
          <span>
            {t('ui.chat-settings.computer-active-now').replace('{0}', state.active.join(' · '))}
          </span>{' '}
          <Button
            size="sm"
            variant="danger"
            onClick={() => void stop()}
            data-testid="computer-stop"
          >
            {t('ui.foundation.stop')}
          </Button>
        </Notice>
      ) : null}
      {cur === 'setup' ? (
        <div className={styles.grid}>
          <SettingsGroup
            title={t('ui.chat-settings.computer-executor')}
            description={t('ui.chat-settings.computer-executor-desc')}
          >
            <SettingRow
              data-testid="computer-status"
              title={
                <span className={styles.status}>
                  {statusText}
                  {state.installed ? (
                    <Badge tone="success">{t('ui.chat-settings.computer-ready')}</Badge>
                  ) : null}
                </span>
              }
              description={
                state.installed ? (
                  <span className={styles.path} title={state.path}>
                    {state.path}
                  </span>
                ) : (
                  t('ui.chat-settings.computer-install-hint')
                )
              }
            >
              <div className={styles.buttons}>
                {state.installed ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={checking || busy}
                    onClick={() => void check()}
                    data-testid="computer-check-update"
                  >
                    {checking
                      ? t('ui.mascot-theme.onb-agents-checking')
                      : t('ui.mascot-theme.check-for-updates')}
                  </Button>
                ) : null}
                {!state.installed || state.updateAvailable ? (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || !state.npmAvailable}
                    onClick={() => void install()}
                    data-testid="computer-install"
                  >
                    {busy
                      ? t('ui.chat-settings.computer-installing')
                      : state.installed
                        ? t('ui.chat-settings.computer-update-to').replace('{0}', state.latest)
                        : t('ui.models.install')}
                  </Button>
                ) : null}
              </div>
            </SettingRow>
            {updateText ? (
              <p className={styles.hint} data-testid="computer-update-status">
                {updateText}
              </p>
            ) : null}
            {!state.npmAvailable && !state.installed ? (
              <Notice tone="warning" icon={AlertTriangle} data-testid="computer-need-node">
                {t('ui.chat-settings.computer-need-node')}
              </Notice>
            ) : null}
            {state.unsupported ? (
              <Notice tone="warning" icon={AlertTriangle}>
                {t('ui.chat-settings.computer-unsupported-major')
                  .replace('{0}', state.version)
                  .replace('{1}', String(state.supportedMajor))}
              </Notice>
            ) : null}
            {state.newerMajor && !state.unsupported ? (
              <Notice tone="info" icon={Info} data-testid="computer-newer-major">
                {t('ui.chat-settings.computer-newer-major').replace('{0}', state.newerMajor)}
              </Notice>
            ) : null}
            {result?.needsUserScope ? (
              <Notice tone="warning" icon={AlertTriangle} data-testid="computer-user-scope">
                <span>
                  {t('ui.chat-settings.computer-global-not-writable').replace(
                    '{0}',
                    result.userPrefix ?? '',
                  )}
                </span>{' '}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void install('user')}
                >
                  {t('ui.chat-settings.computer-install-to-user-dir')}
                </Button>
              </Notice>
            ) : result && !result.ok ? (
              <Notice tone="danger" icon={AlertTriangle} data-testid="computer-install-failed">
                {t('ui.chat-settings.computer-install-failed')}
                {result.log ? (
                  <Disclosure summary={t('ui.chat-settings.computer-install-log')}>
                    <pre className={styles.log}>{result.log}</pre>
                  </Disclosure>
                ) : null}
              </Notice>
            ) : null}
          </SettingsGroup>

          <SettingsGroup
            title={t('ui.chat-settings.computer-permissions')}
            description={
              !state.installed
                ? undefined
                : state.permissionApp
                  ? t('ui.chat-settings.computer-permissions-app').replace(
                      '{0}',
                      state.permissionApp,
                    )
                  : t('ui.chat-settings.computer-permissions-desc')
            }
            actions={
              state.installed ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={rechecking}
                  onClick={() => void recheck()}
                  data-testid="computer-perm-recheck"
                >
                  {t('ui.chat-settings.computer-perm-recheck')}
                </Button>
              ) : undefined
            }
          >
            {state.installed ? (
              <>
                <SettingRow
                  data-testid="computer-perm-accessibility"
                  title={t('ui.chat-settings.computer-perm-accessibility')}
                  description={t('ui.chat-settings.computer-perm-accessibility-desc')}
                >
                  <div className={styles.buttons}>
                    <Badge tone={PERM_TONE[accessibility ?? ''] ?? 'warning'}>
                      {permLabel(accessibility)}
                    </Badge>
                    {mac && accessibility !== 'granted' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void openGuide()}
                        data-testid="computer-open-guide"
                      >
                        {t('ui.chat-settings.computer-open-guide')}
                      </Button>
                    ) : null}
                  </div>
                </SettingRow>
                <SettingRow
                  title={t('ui.chat-settings.computer-perm-screen')}
                  description={t('ui.chat-settings.computer-perm-screen-desc')}
                >
                  <Badge tone={PERM_TONE[screen ?? ''] ?? 'warning'}>{permLabel(screen)}</Badge>
                </SettingRow>
              </>
            ) : null}
            {/* 紧急停止、编程助手、视觉兜底：同一张卡里的几行，不再单独成块 */}
            <ComputerOptions part="rows" state={state} update={update} reload={() => load(false)} />
            {state.wayland ? (
              <Notice tone="info" icon={Info}>
                {t('ui.chat-settings.computer-wayland')}
              </Notice>
            ) : null}
          </SettingsGroup>
        </div>
      ) : null}

      {cur === 'privacy' ? (
        <div className={styles.grid}>
          <ComputerOptions part="safety" state={state} update={update} reload={() => load(false)} />
        </div>
      ) : null}
    </SectionPage>
  );
};
