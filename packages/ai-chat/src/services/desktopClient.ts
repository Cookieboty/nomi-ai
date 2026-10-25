import { t } from '@nomi-ai/ui';
/**
 * 桌面能力（文件授权 / 工具权限 / 审计 / 撤销）客户端：`ai:desktop:*` IPC（经 preload 的 window.aiIPC）。
 * 授权文件夹一律由主进程弹出系统选择框，渲染层无法直接传入路径授权。
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

export interface NoteMetaView {
  id: string;
  title: string;
  tags: string[];
  created: number;
  updated: number;
}
export interface NoteView extends NoteMetaView {
  body: string;
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

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, fn: (payload: unknown) => void) => () => void;
}

function bridge(): AiBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
}

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error(t('ui.chat-settings.desktop-abilities-require-the-desktop-app'));
  return (await b.invoke(`ai:desktop:${method}`, ...args)) as T;
}

const on = (ch: string, fn: (p: unknown) => void) => bridge()?.on(ch, fn) ?? (() => undefined);

export const desktopClient = {
  available: () => !!bridge(),
  state: () => call<DesktopState>('state'),
  grant: (mode: 'read' | 'read-write') => call<ScopeView | null>('grant', mode),
  revoke: (id: string) => call<boolean>('revoke', id),
  setPolicy: (tool: string, policy: Policy) => call<boolean>('set-policy', tool, policy),
  setLocalOnly: (v: boolean) => call<boolean>('set-local-only', v),
  resetCloudAcks: () => call<boolean>('reset-cloud-acks'),
  audit: (limit = 200) => call<AuditEntryView[]>('audit', limit),
  clearAudit: () => call<boolean>('audit-clear'),
  journal: () => call<JournalView[]>('journal'),
  undoLast: () => call<{ ok: boolean; undone?: string; error?: string }>('undo-last'),
  resetAll: () => call<boolean>('reset-all'),
  onChanged: (fn: (s: DesktopState) => void) =>
    on('ai:desktop:changed', (p) => fn(p as DesktopState)),
  notes: (query?: string) =>
    call<Array<NoteMetaView & { snippet?: string }>>('notes-list', query ?? ''),
  readNote: (id: string) => call<NoteView | null>('notes-read', id),
  saveNote: (n: { id?: string; title: string; body: string; tags?: string[] }) =>
    call<NoteView>('notes-save', n),
  trashNote: (id: string) => call<boolean>('notes-trash', id),
  reminders: (all = false) => call<ReminderView[]>('reminders-list', all),
  createReminder: (r: { text: string; at?: string; inMinutes?: number; repeat?: RepeatRule }) =>
    call<ReminderView | null>('reminders-create', r),
  updateReminder: (id: string, p: { text?: string; at?: string; repeat?: RepeatRule | null }) =>
    call<ReminderView | null>('reminders-update', id, p),
  cancelReminder: (id: string) => call<boolean>('reminders-cancel', id),
  snoozeReminder: (id: string, minutes = 10) => call<boolean>('reminders-snooze', id, minutes),
  onP2Changed: (fn: (kind: 'notes' | 'reminders') => void) =>
    on('ai:desktop:p2-changed', (p) => fn((p as { kind: 'notes' | 'reminders' }).kind)),
  onOpenPanel: (fn: () => void) => on('ai:desktop:open-panel', () => fn()),
  /** 看板娘工具栏「任务看板」→ 打开「知识 · 记忆 · 日程」面板的日程页 */
  onOpenSchedule: (fn: () => void) => on('ai:hub:open-schedule', () => fn()),
  /** 看板娘「TTS 语音配置」/ 语音错误「去设置」→ 设置 → 语音与屏幕 → 语音 */
  onOpenVoiceSettings: (fn: () => void) => on('ai:settings:open-voice', () => fn()),
  onSummary: (fn: (e: DesktopSummaryEvent) => void) =>
    on('ai:desktop:summary', (p) => fn(p as DesktopSummaryEvent)),
};

export const TOOL_LABELS: Record<string, string> = {
  desktop_request_scope: 'ui.chat-settings.request-folder-access',
  fs_list: 'ui.chat-settings.list-folder',
  fs_stat: 'ui.chat-settings.view-file-info',
  fs_search: 'ui.chat-settings.search-files',
  fs_read_text: 'ui.chat-settings.read-file-text',
  fs_summarize: 'ui.chat-settings.summarize-file-label',
  fs_write_text: 'ui.chat-settings.write-text-file',
  fs_trash: 'ui.chat-settings.move-to-trash',
  undo_last: 'ui.chat-settings.undo-last-step',
  grant_scope: 'ui.foundation.granted-folders',
  revoke_scope: 'ui.foundation.revoke',
  drop_summarize: 'ui.chat-settings.drop-onto-nomi-to-summarize',
  note_create: 'ui.foundation.new-note',
  note_list: 'ui.chat-settings.list-notes',
  note_search: 'ui.chat-settings.search-notes',
  note_read: 'ui.chat-settings.read-note',
  note_update: 'ui.chat-settings.edit-note',
  note_trash: 'ui.chat-settings.delete-note-trash',
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
