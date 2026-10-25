/**
 * 设置 → 通知：灵动岛式通知开关 / 样式 / 类型，测试按钮。主进程 IslandService（island:*）。
 */
import { Button, SettingRow, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import styles from './index.module.css';

interface IslandState {
  enabled: boolean;
  style: 'auto' | 'pill';
  kinds: { message: boolean; agent: boolean; reminder: boolean };
  mode: 'notch' | 'pill';
  platform: string;
}

type Invoke = (ch: string, ...a: unknown[]) => Promise<unknown>;
type NamedApi = Record<string, (...a: unknown[]) => Promise<unknown>>;
/** preload 只暴露命名白名单（electronAPI.island.*），这里把通道名映射到具名方法 */
const CHANNELS: Record<string, string> = {
  'island:get': 'get',
  'island:set': 'set',
  'island:test': 'test',
};
const invoke = (): Invoke | null => {
  const api = (window as unknown as { electronAPI?: { island?: NamedApi } }).electronAPI?.island;
  if (!api) return null;
  return (ch, ...a) => {
    const fn = api[CHANNELS[ch] ?? ''];
    return fn ? fn(...a) : Promise.reject(new Error(`unknown channel ${ch}`));
  };
};

export const IslandSettings: React.FC = () => {
  const [s, setS] = useState<IslandState | null>(null);
  const load = useCallback(() => {
    void invoke()?.('island:get').then((v) => setS(v as IslandState));
  }, []);
  useEffect(load, [load]);
  const set = (p: Partial<IslandState>) => void invoke()?.('island:set', p).then(load);

  if (!invoke())
    return (
      <section className={styles.block} data-testid="settings-island">
        <p className={styles.muted}>{t('ui.mascot-theme.available-in-the-desktop-app-only')}</p>
      </section>
    );
  if (!s) return null;
  const mac = s.platform === 'darwin';
  const KINDS = [
    [
      'message',
      t('ui.mascot-theme.proactive-ai-messages'),
      t('ui.chat-settings.nomi-starting-a-chat-daily-briefings-and-more'),
    ],
    [
      'agent',
      t('ui.mascot-theme.coding-agent-progress'),
      t('ui.chat-settings.when-a-coding-assistant-finishes-needs-confirmation-or'),
    ],
    [
      'reminder',
      t('ui.mascot-theme.schedule-reminders'),
      t('ui.chat-settings.due-reminders-and-scheduled-task-results'),
    ],
  ] as const;
  return (
    <div className={styles.groups} data-testid="settings-island">
      <SettingsGroup
        title={t('ui.chat-settings.dynamic-island')}
        description={
          mac
            ? s.mode === 'notch'
              ? t('ui.mascot-theme.notch-display-detected-notifications-expand-out-of-the')
              : t('ui.mascot-theme.no-notch-on-this-display-notifications-appear-as')
            : t('ui.mascot-theme.on-windows-linux-this-is-an-optional-top')
        }
        actions={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!s.enabled}
            data-testid="island-test"
            onClick={() => void invoke()?.('island:test')}
          >
            {t('ui.mascot-theme.preview-a-notification')}
          </Button>
        }
      >
        <SettingRow
          title={t('ui.mascot-theme.enable-dynamic-island-notifications')}
          description={t('ui.chat-settings.when-off-nomi-bubbles-and-system-notifications-are')}
        >
          <Switch
            checked={s.enabled}
            onChange={(v) => set({ enabled: v })}
            aria-label={t('ui.mascot-theme.enable-dynamic-island-notifications')}
            data-testid="island-enabled"
          />
        </SettingRow>
        {mac && (
          <SettingRow
            title={t('ui.chat-settings.always-use-the-top-pill')}
            description={t('ui.chat-settings.show-centered-at-the-top-of-the-screen')}
          >
            <Switch
              checked={s.style === 'pill'}
              disabled={!s.enabled}
              onChange={(v) => set({ style: v ? 'pill' : 'auto' })}
              aria-label={t('ui.mascot-theme.always-use-the-top-pill-not-the-notch')}
              data-testid="island-pill"
            />
          </SettingRow>
        )}
      </SettingsGroup>
      <SettingsGroup
        title={t('ui.chat-settings.notification-types')}
        description={t('ui.mascot-theme.nothing-pops-up-during-quiet-hours-schedule-calendar')}
      >
        {KINDS.map(([k, label, desc]) => (
          <SettingRow key={k} title={label} description={desc}>
            <Switch
              checked={s.kinds[k]}
              disabled={!s.enabled}
              onChange={(v) => set({ kinds: { ...s.kinds, [k]: v } })}
              aria-label={label}
              data-testid={`island-kind-${k}`}
            />
          </SettingRow>
        ))}
      </SettingsGroup>
    </div>
  );
};
