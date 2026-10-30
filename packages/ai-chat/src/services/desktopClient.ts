import { t } from '@nomi-ai/ui';

import { api, hasTransport } from './api';
import { onChatNav, onDesktopSummary } from './pendingNav';
/**
 * 桌面能力（文件授权 / 工具权限 / 审计 / 撤销）客户端：契约 `desktop.*`（docs/design/core-host-decoupling.md
 * §12 P1b，原 `ai:desktop:*`）。授权文件夹一律由主进程弹出系统选择框，渲染层无法直接传入路径授权。
 */
export type Danger = 'read' | 'write' | 'destructive';
export type Policy = 'always' | 'session' | 'ask';

export interface ScopeView {
  id: string;
  path: string;
  mode: 'read' | 'read-write';
  kind: 'folder' | 'file';
  grantedAt: number;
  session?: boolean;
}

export interface DesktopState {
  scopes: ScopeView[];
  policies: Record<string, Policy>;
  localOnly: boolean;
  cloudAcked: string[];
  tools: Array<{ name: string; danger: Danger; policy: Policy; locked?: boolean }>;
}

export interface AuditEntryView {
  ts: number;
  tool: string;
  args: Record<string, unknown>;
  decision: string;
  result: string;
  ms?: number;
  source?: string;
  provider?: string;
}

export interface JournalView {
  id: string;
  ts: number;
  tool: string;
  summary: string;
  undone: boolean;
}

export interface DesktopSummaryEvent {
  name: string;
  path: string;
  summary: string;
  at: number;
}

export interface ReminderView {
  id: string;
  text: string;
  dueAt: number;
  createdAt: number;
  status: 'pending' | 'fired' | 'missed' | 'cancelled' | 'done';
  snoozes?: number;
  repeat?: RepeatRule;
  fireCount?: number;
}

export type RepeatRule =
  | { kind: 'daily' }
  | { kind: 'weekdays' }
  | { kind: 'weekly'; days: number[] }
  | { kind: 'monthly' }
  | { kind: 'interval'; minutes: number };

const WEEK = [
  'ui.foundation.sun',
  'ui.foundation.mon',
  'ui.foundation.tue',
  'ui.foundation.wed',
  'ui.foundation.thu',
  'ui.foundation.fri',
  'ui.foundation.sat',
];
export function describeRepeat(r?: RepeatRule): string {
  if (!r) return t('ui.foundation.does-not-repeat');
  switch (r.kind) {
    case 'daily':
      return t('ui.foundation.every-day');
    case 'weekdays':
      return t('ui.foundation.weekdays');
    case 'monthly':
      return t('ui.foundation.monthly');
    case 'weekly':
      return t(
        'ui.chat-settings.weekly-on',
        [...r.days]
          .sort()
          .map((d) => t(WEEK[d]!))
          .join('、'),
      );
    case 'interval':
      return r.minutes % 60 === 0
        ? t('ui.chat-settings.every-h', r.minutes / 60)
        : t('ui.chat-settings.every-min', r.minutes);
  }
}

/** 没有契约传输（浏览器预览 / 测试）时与原来一样报「需要桌面应用」 */
async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!hasTransport())
    throw new Error(t('ui.chat-settings.desktop-abilities-require-the-desktop-app'));
  return (await run()) as T;
}

const noop = () => undefined;
const on = (subscribe: () => () => void): (() => void) => (hasTransport() ? subscribe() : noop);

export const desktopClient = {
  available: () => hasTransport(),
  state: () => call<DesktopState>(() => api.desktop.state()),
  grant: (mode: 'read' | 'read-write') => call<ScopeView | null>(() => api.desktop.grant({ mode })),
  revoke: (id: string) => call<boolean>(() => api.desktop.revoke({ id })),
  setPolicy: (tool: string, policy: Policy) =>
    call<boolean>(() => api.desktop.setPolicy({ tool, policy })),
  setLocalOnly: (v: boolean) => call<boolean>(() => api.desktop.setLocalOnly({ value: v })),
  resetCloudAcks: () => call<boolean>(() => api.desktop.resetCloudAcks()),
  audit: (limit = 200) => call<AuditEntryView[]>(() => api.desktop.audit({ limit })),
  clearAudit: () => call<boolean>(() => api.desktop.auditClear()),
  journal: () => call<JournalView[]>(() => api.desktop.journal()),
  undoLast: () =>
    call<{ ok: boolean; undone?: string; error?: string }>(() => api.desktop.undoLast()),
  resetAll: () => call<boolean>(() => api.desktop.resetAll()),
  onChanged: (fn: (s: DesktopState) => void) =>
    on(() => api.on('desktop.changed', (p) => fn(p as DesktopState))),
  reminders: (all = false) => call<ReminderView[]>(() => api.desktop.remindersList({ all })),
  createReminder: (r: { text: string; at?: string; inMinutes?: number; repeat?: RepeatRule }) =>
    call<ReminderView | null>(() => api.desktop.remindersCreate(r)),
  updateReminder: (id: string, p: { text?: string; at?: string; repeat?: RepeatRule | null }) =>
    call<ReminderView | null>(() => api.desktop.remindersUpdate({ id, patch: p })),
  cancelReminder: (id: string) => call<boolean>(() => api.desktop.remindersCancel({ id })),
  snoozeReminder: (id: string, minutes = 10) =>
    call<boolean>(() => api.desktop.remindersSnooze({ id, minutes })),
  onP2Changed: (fn: (kind: 'reminders') => void) =>
    on(() => api.on('desktop.p2Changed', (p) => fn(p.kind as 'reminders'))),
  // 面板导航与拖入总结：窗口挂载前发出的那一次由内核留着，第一次订阅后拉取（./pendingNav）
  /** 托盘「桌面能力」→ 打开桌面能力面板 */
  onOpenPanel: (fn: () => void) => onChatNav('nav.desktopPanelRequested', fn),
  /** 看板娘工具栏「任务看板」→ 打开「知识 · 记忆 · 日程」面板的日程页 */
  onOpenSchedule: (fn: () => void) => onChatNav('nav.scheduleRequested', fn),
  /** 看板娘「TTS 语音配置」/ 语音错误「去设置」→ 设置 → 语音与屏幕 → 语音 */
  onOpenVoiceSettings: (fn: () => void) => onChatNav('nav.voiceSettingsRequested', fn),
  onSummary: (fn: (e: DesktopSummaryEvent) => void) => onDesktopSummary(fn),
};

export const TOOL_LABELS: Record<string, string> = {
  desktop_request_scope: 'ui.chat-settings.request-folder-access',
  fs_list: 'ui.chat-settings.list-folder',
  fs_stat: 'ui.chat-settings.view-file-info',
  fs_search: 'ui.chat-settings.search-files',
  fs_read_text: 'ui.chat-settings.read-file-text',
  fs_summarize: 'ui.chat-settings.summarize-file-label',
  fs_write_text: 'ui.chat-settings.write-text-file',
  fs_edit: 'ui.chat-settings.edit-text-file',
  fs_mkdir: 'ui.chat-settings.create-folder',
  fs_move: 'ui.chat-settings.move-or-rename',
  fs_copy: 'ui.chat-settings.copy-file',
  fs_trash: 'ui.chat-settings.move-to-trash',
  undo_last: 'ui.chat-settings.undo-last-step',
  grant_scope: 'ui.foundation.granted-folders',
  revoke_scope: 'ui.foundation.revoke',
  drop_summarize: 'ui.chat-settings.drop-onto-nomi-to-summarize',
  reminder_create: 'ui.chat-settings.set-reminder',
  reminder_list: 'ui.chat-settings.view-reminders',
  reminder_cancel: 'ui.chat-settings.cancel-reminder',
  reminder_snooze: 'ui.chat-settings.snooze-reminder',
  reminder_fire: 'ui.chat-settings.reminder-fired',
  clipboard_read: 'ui.chat-settings.read-clipboard',
  clipboard_write: 'ui.chat-settings.write-clipboard',
  browser_open: 'ui.chat-settings.sandbox-browser-open-page',
  browser_read: 'ui.chat-settings.sandbox-browser-read-page',
  browser_click: 'ui.chat-settings.sandbox-browser-click',
  browser_type: 'ui.chat-settings.sandbox-browser-type-text',
  browser_close: 'ui.chat-settings.sandbox-browser-close',
  code_run: 'ui.chat-settings.run-code-in-sandbox',
};

export const DANGER_LABELS: Record<Danger, string> = {
  read: 'ui.foundation.read-only',
  write: 'ui.chat-settings.write',
  destructive: 'ui.foundation.destructive',
};
export const POLICY_LABELS: Record<Policy, string> = {
  always: 'ui.chat-settings.always-allow',
  session: 'ui.chat-settings.ask-first-time-each-session',
  ask: 'ui.chat-settings.ask-every-time',
};
