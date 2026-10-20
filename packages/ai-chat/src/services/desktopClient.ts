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

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export function describeRepeat(r?: RepeatRule): string {
  if (!r) return t('不重复');
  switch (r.kind) {
    case 'daily':
      return t('每天');
    case 'weekdays':
      return t('工作日');
    case 'monthly':
      return t('每月');
    case 'weekly':
      return t(
        '每周{0}',
        [...r.days]
          .sort()
          .map((d) => WEEK[d])
          .join('、'),
      );
    case 'interval':
      return r.minutes % 60 === 0 ? t('每 {0} 小时', r.minutes / 60) : t('每 {0} 分钟', r.minutes);
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
  if (!b) throw new Error(t('桌面能力需要在桌面应用中使用'));
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
  onSummary: (fn: (e: DesktopSummaryEvent) => void) =>
    on('ai:desktop:summary', (p) => fn(p as DesktopSummaryEvent)),
};

export const TOOL_LABELS: Record<string, string> = {
  desktop_request_scope: '请求授权文件夹',
  fs_list: '列出文件夹',
  fs_stat: '查看文件信息',
  fs_search: '搜索文件',
  fs_read_text: '读取文件文本',
  fs_summarize: '总结文件',
  fs_write_text: '写入文本文件',
  fs_trash: '移到回收站',
  undo_last: '撤销上一步',
  grant_scope: '授权文件夹',
  revoke_scope: '撤销授权',
  drop_summarize: '拖到 Nomi 总结',
  note_create: '新建笔记',
  note_list: '列出笔记',
  note_search: '搜索笔记',
  note_read: '读取笔记',
  note_update: '修改笔记',
  note_trash: '删除笔记（回收站）',
  reminder_create: '设置提醒',
  reminder_list: '查看提醒',
  reminder_cancel: '取消提醒',
  reminder_snooze: '稍后提醒',
  reminder_fire: '提醒触发',
  clipboard_read: '读取剪贴板',
  clipboard_write: '写入剪贴板',
  browser_open: '沙箱浏览器：打开网页',
  browser_read: '沙箱浏览器：读取页面',
  browser_click: '沙箱浏览器：点击',
  browser_type: '沙箱浏览器：输入文字',
  browser_close: '沙箱浏览器：关闭',
  code_run: '沙箱运行代码',
};

export const DANGER_LABELS: Record<Danger, string> = {
  read: '只读',
  write: '写入',
  destructive: '破坏性',
};
export const POLICY_LABELS: Record<Policy, string> = {
  always: '总是允许',
  session: '每次运行首次询问',
  ask: '每次都询问',
};
