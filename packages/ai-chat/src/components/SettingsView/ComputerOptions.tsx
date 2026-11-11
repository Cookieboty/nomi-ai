/**
 * 设置 → Computer Use 的选项：视觉兜底模型、读界面时打码、另外禁止操作的应用、隔离模式（agent-desktop 沙箱）。
 */
import {
  Badge,
  Button,
  Disclosure,
  Icon,
  IconButton,
  Input,
  Select,
  SettingRow,
  SettingsGroup,
  Switch,
  t,
} from '@nomi-ai/ui';
import { X } from 'lucide-react';
import React, { useState } from 'react';

import { api } from '../../services/api';

import type { ComputerSettingsPatch, ComputerState } from './ComputerSection';
import styles from './ComputerSection.module.css';

/** 紧急停止快捷键的可选项（Wails 写法；"" = 默认） */
const STOP_SHORTCUTS = ['', 'CmdOrCtrl+Alt+Shift+X', 'CmdOrCtrl+Shift+F12', 'off'];

/** 显示用：macOS 用符号，其它平台用 Ctrl / Alt / Shift */
export function formatAccel(accel: string, mac: boolean): string {
  const map: Record<string, string> = mac
    ? { cmdorctrl: '⌘', alt: '⌥', optionoralt: '⌥', shift: '⇧', ctrl: '⌃' }
    : { cmdorctrl: 'Ctrl', alt: 'Alt', optionoralt: 'Alt', shift: 'Shift', ctrl: 'Ctrl' };
  const parts = accel.split('+').map((p) => map[p.toLowerCase()] ?? p.toUpperCase());
  return parts.join(mac ? '' : '+');
}

interface Props {
  /** rows：权限卡里的停止快捷键 / 编程助手 / 视觉模型几行；safety：打码 / 禁止的应用 / 隔离模式（安全与隐私页） */
  part: 'rows' | 'safety';
  state: ComputerState;
  update: (patch: ComputerSettingsPatch) => Promise<void>;
  reload: () => Promise<void>;
}

export const ComputerOptions: React.FC<Props> = ({ part, state, update, reload }) => {
  const [app, setApp] = useState('');
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [sandboxError, setSandboxError] = useState('');

  const addApp = () => {
    const v = app.trim();
    if (!v || state.blockedApps.some((a) => a.toLowerCase() === v.toLowerCase())) {
      setApp('');
      return;
    }
    void update({ blockedApps: [...state.blockedApps, v] });
    setApp('');
  };

  const sandboxAction = async (action: 'start' | 'stop') => {
    setSandboxBusy(true);
    setSandboxError('');
    try {
      const r = await api.computer.sandboxAction({ name: state.sandbox, action });
      if (!r.ok) setSandboxError(r.message);
      await reload();
    } finally {
      setSandboxBusy(false);
    }
  };

  const visionMissing =
    state.visionModel !== '' && !state.visionModels.some((m) => m.ref === state.visionModel);
  const current = state.sandboxes.find((s) => s.name === state.sandbox);
  const running = current?.state === 'running';

  const mac = state.platform === 'darwin';
  const shortcutLabel = (v: string) =>
    v === 'off'
      ? t('ui.chat-settings.computer-shortcut-off')
      : formatAccel(v || state.defaultStopShortcut, mac);

  if (part === 'rows') {
    return (
      <>
        <SettingRow
          data-testid="computer-stop-shortcut"
          title={t('ui.chat-settings.computer-shortcut')}
          description={
            state.stopShortcutError
              ? t('ui.chat-settings.computer-shortcut-failed').replace(
                  '{0}',
                  state.stopShortcutError,
                )
              : state.stopShortcutActive
                ? t('ui.chat-settings.computer-shortcut-desc')
                : t('ui.chat-settings.computer-shortcut-none')
          }
        >
          <Select
            size="sm"
            value={state.stopShortcut}
            aria-label={t('ui.chat-settings.computer-shortcut')}
            onChange={(e) => void update({ stopShortcut: e.target.value })}
            options={STOP_SHORTCUTS.map((v) => ({ value: v, label: shortcutLabel(v) }))}
          />
        </SettingRow>
        <SettingRow
          data-testid="computer-auto-approve"
          title={t('ui.chat-settings.computer-auto-approve')}
          description={t('ui.chat-settings.computer-auto-approve-desc')}
        >
          <Switch
            checked={state.autoApprove}
            onChange={(on) => void update({ autoApprove: on })}
            aria-label={t('ui.chat-settings.computer-auto-approve')}
          />
        </SettingRow>
        <SettingRow
          data-testid="computer-cli-enabled"
          title={t('ui.chat-settings.computer-cli-enabled')}
          description={t('ui.chat-settings.computer-cli-enabled-desc')}
        >
          <Switch
            checked={state.cliEnabled}
            disabled={!state.installed}
            onChange={(on) => void update({ cliEnabled: on })}
            aria-label={t('ui.chat-settings.computer-cli-enabled')}
          />
        </SettingRow>
        <SettingRow
          data-testid="computer-vision-model"
          title={t('ui.chat-settings.computer-vision-model')}
          description={
            state.visionModels.length === 0
              ? t('ui.chat-settings.computer-vision-none')
              : visionMissing
                ? t('ui.chat-settings.computer-vision-missing')
                : t('ui.chat-settings.computer-vision-desc')
          }
        >
          <Select
            size="sm"
            value={state.visionModel}
            aria-label={t('ui.chat-settings.computer-vision-model')}
            onChange={(e) => void update({ visionModel: e.target.value })}
            options={[
              { value: '', label: t('ui.chat-settings.computer-vision-off') },
              ...state.visionModels.map((m) => ({
                value: m.ref,
                label: m.label,
                description: m.provider,
              })),
            ]}
          />
        </SettingRow>
      </>
    );
  }

  return (
    <>
      <SettingsGroup title={t('ui.chat-settings.computer-privacy')}>
        <SettingRow
          data-testid="computer-redact"
          title={t('ui.chat-settings.computer-redact')}
          description={t('ui.chat-settings.computer-redact-desc')}
        >
          <Switch
            checked={state.redact}
            onChange={(on) => void update({ redact: on })}
            aria-label={t('ui.chat-settings.computer-redact')}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title={t('ui.chat-settings.computer-blocked-apps')}
        description={t('ui.chat-settings.computer-blocked-apps-desc')}
      >
        <div className={styles.chips} data-testid="computer-blocked-apps">
          {state.blockedApps.map((a) => (
            <span key={a} className={styles.chip}>
              {a}
              <IconButton
                size="sm"
                icon={<Icon icon={X} size={14} />}
                label={t('ui.providers-schedule.task-folders-remove').replace('{0}', a)}
                onClick={() =>
                  void update({ blockedApps: state.blockedApps.filter((x) => x !== a) })
                }
              />
            </span>
          ))}
        </div>
        <form
          className={styles.addRow}
          onSubmit={(e) => {
            e.preventDefault();
            addApp();
          }}
        >
          <Input
            size="sm"
            value={app}
            maxLength={200}
            placeholder={t('ui.chat-settings.computer-blocked-placeholder')}
            aria-label={t('ui.chat-settings.computer-blocked-placeholder')}
            onChange={(e) => setApp(e.target.value)}
            data-testid="computer-blocked-input"
          />
          <Button size="sm" variant="secondary" type="submit" disabled={!app.trim()}>
            {t('ui.chat-settings.computer-blocked-add')}
          </Button>
        </form>
      </SettingsGroup>

      {state.platform === 'darwin' && state.installed && state.sandboxSupported ? (
        <SettingsGroup
          title={t('ui.chat-settings.computer-sandbox')}
          description={t('ui.chat-settings.computer-sandbox-desc')}
        >
          <SettingRow
            data-testid="computer-sandbox"
            title={t('ui.chat-settings.computer-sandbox-target')}
            description={
              state.sandboxes.length === 0
                ? t('ui.chat-settings.computer-sandbox-none')
                : state.sandbox
                  ? t('ui.chat-settings.computer-sandbox-on').replace('{0}', state.sandbox)
                  : t('ui.chat-settings.computer-sandbox-off')
            }
          >
            <div className={styles.buttons}>
              {state.sandbox && current ? (
                <Badge tone={running ? 'success' : 'neutral'}>{current.state}</Badge>
              ) : null}
              {state.sandbox && current ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={sandboxBusy}
                  onClick={() => void sandboxAction(running ? 'stop' : 'start')}
                  data-testid="computer-sandbox-toggle"
                >
                  {running
                    ? t('ui.chat-settings.computer-sandbox-stop')
                    : t('ui.chat-settings.computer-sandbox-start')}
                </Button>
              ) : null}
              <Select
                size="sm"
                value={state.sandbox}
                aria-label={t('ui.chat-settings.computer-sandbox-target')}
                onChange={(e) => void update({ sandbox: e.target.value })}
                options={[
                  { value: '', label: t('ui.chat-settings.computer-sandbox-this-mac') },
                  ...state.sandboxes.map((s) => ({
                    value: s.name,
                    label: s.name,
                    description: s.state,
                  })),
                ]}
              />
            </div>
          </SettingRow>
          {sandboxError ? <p className={styles.hint}>{sandboxError}</p> : null}
          <Disclosure summary={t('ui.chat-settings.computer-sandbox-howto')}>
            <pre className={styles.log}>
              {
                'agent-desktop sandbox install macos\nagent-desktop sandbox create <name> --provider macos --set ipsw=latest'
              }
            </pre>
            <p className={styles.hint}>{t('ui.chat-settings.computer-sandbox-howto-desc')}</p>
          </Disclosure>
        </SettingsGroup>
      ) : null}
    </>
  );
};
