/**
 * 设置 → 调试（只在开发版出现，见 sections.ts 的 DEV_SECTIONS）：在真的灵动岛上看各种样式。
 * 通知走 island.debug notice（不论开关与免打扰）；「等你处理」的样例走 island.debug pending（整份替换，
 * 点样例上的按钮只会把它拿掉，不会真的允许 / 拒绝什么）。内核只在开发版接受 island.debug。
 */
import { brand } from '@nomi-ai/types';
import { Button, SettingRow, SettingsGroup, t } from '@nomi-ai/ui';
import React, { useState } from 'react';

import { api, hasTransport } from '../../services/api';

import styles from './index.module.css';

type DebugInput = Parameters<typeof api.island.debug>[0];
type Notice = Extract<DebugInput, { op: 'notice' }>['notice'];
type Item = Extract<DebugInput, { op: 'pending' }>['items'][number];

const allow = () => [
  { id: 'allow', label: t('ui.chat-settings.allow'), primary: true },
  { id: 'deny', label: t('ui.chat-settings.deny') },
];

/** 通知样例：每种状态一条，外加编程助手进度与超长文本（看截断） */
const NOTICES: { key: string; label: string; notice: () => Notice }[] = [
  {
    key: 'message',
    label: 'ui.mascot-theme.island-debug-n-message',
    notice: () => ({
      kind: 'message',
      title: brand.appName,
      body: t('ui.mascot-theme.island-debug-message-body'),
    }),
  },
  {
    key: 'running',
    label: 'ui.chat-settings.in-progress',
    notice: () => ({
      kind: 'agent',
      status: 'running',
      title: t('ui.mascot-theme.island-debug-running-title'),
      body: t('ui.mascot-theme.island-debug-running-body'),
    }),
  },
  {
    key: 'done',
    label: 'ui.usage-tools.done',
    notice: () => ({
      kind: 'agent',
      status: 'done',
      title: t('ui.mascot-theme.island-debug-done-title'),
      body: t('ui.mascot-theme.island-debug-done-body'),
    }),
  },
  {
    key: 'failed',
    label: 'ui.foundation.failed',
    notice: () => ({
      kind: 'agent',
      status: 'failed',
      title: t('ui.mascot-theme.island-debug-failed-title'),
      body: t('ui.mascot-theme.island-debug-failed-body'),
    }),
  },
  {
    key: 'attention',
    label: 'ui.mascot-theme.island-debug-n-attention',
    notice: () => ({
      kind: 'agent',
      status: 'attention',
      endpoint: 'claude',
      title: t('ui.mascot-theme.island-debug-attention-title'),
      body: t('ui.mascot-theme.island-debug-attention-body'),
    }),
  },
  {
    key: 'reminder',
    label: 'ui.foundation.reminders',
    notice: () => ({
      kind: 'reminder',
      title: t('ui.mascot-theme.island-debug-reminder-title'),
      body: t('ui.mascot-theme.island-debug-reminder-body'),
    }),
  },
  {
    key: 'agent',
    label: 'ui.mascot-theme.coding-agent-progress',
    notice: () => ({
      kind: 'agent',
      status: 'running',
      endpoint: 'codex',
      title: t('ui.mascot-theme.island-debug-agent-title'),
      body: t('ui.mascot-theme.island-debug-agent-body'),
    }),
  },
  {
    key: 'long',
    label: 'ui.mascot-theme.island-debug-n-long',
    notice: () => ({
      kind: 'message',
      title: t('ui.mascot-theme.island-debug-long-title'),
      body: t('ui.mascot-theme.island-debug-long-body'),
      durationMs: 8000,
    }),
  },
];

/** 「等你处理」的样例：各来源一条 */
const ITEMS: Record<string, () => Item> = {
  perm: () => ({
    id: 'perm',
    kind: 'permission',
    endpoint: 'claude',
    title: t('ui.mascot-theme.island-perm-title', 'Claude Code'),
    body: 'Bash: pnpm build && git push origin main',
    actions: allow(),
  }),
  task: () => ({
    id: 'task',
    kind: 'task',
    endpoint: 'nomi',
    title: t('ui.providers-schedule.daily-briefing'),
    body: `${t('ui.providers-schedule.task-waiting-approval')} · ${t('ui.mascot-theme.island-debug-task-body')}`,
    actions: [
      { id: 'approve', label: t('ui.providers-schedule.task-approve'), primary: true },
      { id: 'deny', label: t('ui.chat-settings.deny') },
    ],
  }),
  sandbox: () => ({
    id: 'sandbox',
    kind: 'sandbox',
    endpoint: 'codex',
    title: t('ui.mascot-theme.island-sandbox-title', 'Codex'),
    body: 'write ~/.ssh/config',
    actions: [
      { id: 'session', label: t('ui.chat-settings.sandbox-allow-session'), primary: true },
      { id: 'always', label: t('ui.chat-settings.sandbox-allow-always') },
      { id: 'deny', label: t('ui.chat-settings.sandbox-deny') },
    ],
  }),
  plan: () => ({
    id: 'plan',
    kind: 'approve-plan',
    endpoint: 'codex',
    title: t('ui.mascot-theme.island-plan-title', 'Codex'),
    body: t('ui.mascot-theme.island-debug-plan-body'),
    actions: [
      { id: 'acceptEdits', label: t('ui.chat-settings.approve-and-auto-edit'), primary: true },
      { id: 'manual', label: t('ui.chat-settings.ask-each-time') },
      { id: 'deny', label: t('ui.chat-settings.keep-editing') },
    ],
  }),
  confirm: () => ({
    id: 'confirm',
    kind: 'confirm',
    endpoint: 'nomi',
    title: t('ui.mascot-theme.island-confirm-title'),
    body: 'workspace_run · rm -rf node_modules',
    actions: [
      { id: 'allow', label: t('ui.chat-settings.allow'), danger: true },
      { id: 'deny', label: t('ui.chat-settings.deny') },
    ],
  }),
  accept: () => ({
    id: 'accept',
    kind: 'task',
    endpoint: 'gemini',
    title: t('ui.mascot-theme.island-debug-accept-title'),
    body: t('ui.providers-schedule.task-awaiting-accept'),
    actions: [
      { id: 'accept', label: t('ui.mascot-theme.island-accept'), primary: true },
      { id: 'open', label: t('ui.mascot-theme.island-open') },
    ],
  }),
  open: () => ({
    id: 'open',
    kind: 'confirm',
    endpoint: 'nomi',
    title: t('ui.mascot-theme.island-scope-title'),
    body: '~/Projects/nomi-ai',
    actions: [{ id: 'open', label: t('ui.mascot-theme.island-open') }],
  }),
};

const SETS: { key: string; label: string; items: string[] }[] = [
  { key: 'one', label: 'ui.mascot-theme.island-debug-p-one', items: ['perm'] },
  {
    key: 'three',
    label: 'ui.mascot-theme.island-debug-p-three',
    items: ['perm', 'task', 'sandbox'],
  },
  {
    key: 'many',
    label: 'ui.mascot-theme.island-debug-p-many',
    items: ['perm', 'task', 'sandbox', 'plan', 'confirm', 'accept', 'open'],
  },
  { key: 'plan', label: 'ui.chat-settings.approve-plan', items: ['plan'] },
  { key: 'sandbox', label: 'ui.mascot-theme.island-debug-p-sandbox', items: ['sandbox'] },
  { key: 'open', label: 'ui.mascot-theme.island-debug-p-open', items: ['open'] },
];

export const DebugSection: React.FC = () => {
  const [error, setError] = useState('');
  const run = (input: DebugInput) => {
    setError('');
    void api.island.debug(input).catch((e: unknown) => setError(String(e)));
  };
  if (!hasTransport()) {
    return (
      <p className={styles.muted} data-testid="settings-debug">
        {t('ui.mascot-theme.available-in-the-desktop-app-only')}
      </p>
    );
  }
  return (
    <div className={styles.groups} data-testid="settings-debug">
      <SettingsGroup
        title={t('ui.mascot-theme.island-debug-notices')}
        description={t('ui.mascot-theme.island-debug-notices-desc')}
      >
        <SettingRow title={t('ui.mascot-theme.island-debug-notices-row')}>
          <span className={styles.debugButtons}>
            {NOTICES.map((n) => (
              <Button
                key={n.key}
                size="sm"
                variant="secondary"
                onClick={() => run({ op: 'notice', notice: n.notice() })}
                data-testid={`debug-island-notice-${n.key}`}
              >
                {t(n.label)}
              </Button>
            ))}
          </span>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup
        title={t('ui.mascot-theme.island-debug-pending')}
        description={t('ui.mascot-theme.island-debug-pending-desc')}
      >
        <SettingRow title={t('ui.mascot-theme.island-debug-pending-row')}>
          <span className={styles.debugButtons}>
            {SETS.map((s) => (
              <Button
                key={s.key}
                size="sm"
                variant="secondary"
                onClick={() => run({ op: 'pending', items: s.items.map((k) => ITEMS[k]!()) })}
                data-testid={`debug-island-pending-${s.key}`}
              >
                {t(s.label)}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => run({ op: 'clear' })}
              data-testid="debug-island-clear"
            >
              {t('ui.mascot-theme.island-debug-clear')}
            </Button>
          </span>
        </SettingRow>
      </SettingsGroup>
      {error && (
        <p className={styles.muted} role="alert" data-testid="debug-island-error">
          {error}
        </p>
      )}
    </div>
  );
};
