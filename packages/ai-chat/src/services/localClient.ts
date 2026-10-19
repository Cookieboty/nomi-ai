import { t } from '@nomi-ai/ui';
/** 本地中心客户端：本机模型（llama.cpp / Ollama）、日历、剪贴板历史、数据导出（`ai:local:*` / `ai:hub:*`） */
export type Fit = 'ok' | 'tight' | 'too-big';
export interface Progress {
  received: number;
  total: number;
  status?: string;
}
export interface LocalModel {
  id: string;
  name: string;
  family: string;
  params: string;
  quant: string;
  description: string;
  bytes: number;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  minRamGb: number;
  ctx: number;
  installed: boolean;
  fit: Fit;
  downloading?: Progress;
}
export type ServerStatus = 'stopped' | 'starting' | 'running' | 'error';
export interface LocalState {
  ramGb: number;
  recommended: string;
  models: LocalModel[];
  runtime: {
    tag: string;
    license: string;
    licenseUrl: string;
    sourceUrl: string;
    supported: boolean;
    bytes: number;
    installed: boolean;
    downloading?: Progress;
  };
  server: {
    status: ServerStatus;
    model?: string;
    port?: number;
    baseURL?: string;
    error?: string;
    log: string[];
  };
  settings: {
    activeModel?: string;
    autoStart: boolean;
    providerId?: string;
    threads?: number;
    ollamaUrl: string;
  };
  offline: boolean;
}
export interface OllamaModel {
  name: string;
  size: number;
  modifiedAt: string;
  params?: string;
  quant?: string;
  family?: string;
}
export interface CalSource {
  id: string;
  name: string;
  kind: 'local' | 'file' | 'ics-url' | 'caldav' | 'system';
  color: string;
  url?: string;
  username?: string;
  hasPassword?: boolean;
  /** 旧版本留下的明文密码，且当前安全存储不可用、无法迁移 */
  passwordInsecure?: boolean;
  enabled: boolean;
  lastSync?: number;
  lastError?: string;
  count?: number;
}
export interface Occurrence {
  uid: string;
  summary: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  cal: string;
}
export interface ClipItem {
  id: string;
  at: number;
  kind: 'text' | 'image';
  text?: string;
  w?: number;
  h?: number;
  pinned?: boolean;
  thumb?: string;
}
export interface ClipState {
  settings: { enabled: boolean; max: number; images: boolean };
  items: ClipItem[];
}

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, fn: (payload: unknown) => void) => () => void;
}
const bridge = (): AiBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
};
async function call<T>(ch: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error(t('本地中心需要在桌面应用中使用'));
  const r = (await b.invoke(ch, ...args)) as T & { __error?: { code: string; message: string } };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}
const L = <T>(m: string, ...a: unknown[]) => call<T>(`ai:local:${m}`, ...a);
const H = <T>(m: string, ...a: unknown[]) => call<T>(`ai:hub:${m}`, ...a);
const on = (ch: string, fn: (p: unknown) => void) => bridge()?.on(ch, fn) ?? (() => undefined);

export const localClient = {
  available: () => !!bridge(),
  state: () => L<LocalState>('state'),
  setSettings: (p: Partial<LocalState['settings']>) => L('set-settings', p),
  download: (id: string) => L<{ ok: boolean; error?: string }>('download', id),
  downloadRuntime: () => L<{ ok: boolean; error?: string }>('download-runtime'),
  cancel: (id: string) => L('cancel', id),
  remove: (id: string) => L('remove', id),
  removeRuntime: () => L('remove-runtime'),
  start: (id: string) => L<{ baseURL: string; providerId: string }>('start', id),
  stop: () => L('stop'),
  use: () => L('use'),
  offline: (v: boolean) => L('offline', v),
  ollamaList: () => L<OllamaModel[]>('ollama-list'),
  ollamaPull: (n: string) => L('ollama-pull', n),
  ollamaDelete: (n: string) => L('ollama-delete', n),
  onChanged: (fn: () => void) => on('ai:local:changed', () => fn()),
  onProgress: (fn: (p: Progress & { id: string }) => void) =>
    on('ai:local:progress', (p) => fn(p as Progress & { id: string })),
};

export const hubClient = {
  calState: () => H<{ sources: CalSource[] }>('cal-state'),
  calRange: (from: number, to: number) => H<Occurrence[]>('cal-range', from, to),
  calUpsert: (p: Partial<Occurrence> & { rrule?: string; description?: string }) =>
    H('cal-upsert', p),
  calRemove: (uid: string) => H('cal-remove', uid),
  calImport: () => H('cal-import'),
  calAddSource: (p: {
    name: string;
    kind: 'ics-url' | 'caldav';
    url: string;
    username?: string;
    password?: string;
  }) => H('cal-add-source', p),
  calSync: (id: string) => H('cal-sync', id),
  calToggle: (id: string, v: boolean) => H('cal-toggle', id, v),
  calRemoveSource: (id: string) => H('cal-remove-source', id),
  calExport: () => H('cal-export'),
  calSystemInfo: () =>
    H<{ provider: 'macos-calendar' | 'outlook-com' | 'evolution' | null; canCreate: boolean }>(
      'cal-system-info',
    ),
  calSystemConnect: () => H<CalSource | undefined>('cal-system-connect'),
  calSystemCreate: (p: { summary: string; start: number; end: number }) =>
    H<{ ok: boolean; reason?: string; calendar?: string }>('cal-system-create', p),
  clipState: () => H<ClipState>('clip-state'),
  clipSettings: (p: Partial<ClipState['settings']>) => H('clip-settings', p),
  clipCopy: (id: string) => H('clip-copy', id),
  clipImage: (id: string) =>
    H<{ mime: string; data: string; width: number; height: number; source: string }>(
      'clip-image',
      id,
    ),
  clipPin: (id: string, v: boolean) => H('clip-pin', id, v),
  clipRemove: (id: string) => H('clip-remove', id),
  clipClear: () => H('clip-clear'),
  exportAll: (include: string[], conversations?: unknown) =>
    H<{ file: string; bytes: number } | null>('export', { include, conversations }),
  onChanged: (fn: () => void) => on('ai:hub:changed', () => fn()),
  onClips: (fn: () => void) => on('ai:hub:clips', () => fn()),
};

export function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}
export const pct = (p?: Progress) =>
  p && p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;

/** 读取渲染端保存的全部会话（localStorage 中 ai-chat:* 键），用于导出 */
export function collectConversations(
  storage: Pick<Storage, 'length' | 'key' | 'getItem'> = localStorage,
) {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (!k || !k.startsWith('ai-chat:')) continue;
    const v = storage.getItem(k);
    try {
      out[k] = v ? JSON.parse(v) : null;
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export const FIT_LABEL: Record<Fit, string> = {
  ok: '内存充足',
  tight: '内存偏紧',
  'too-big': '内存不足',
};
export const STATUS_LABEL: Record<ServerStatus, string> = {
  stopped: '未运行',
  starting: '启动中',
  running: '运行中',
  error: '出错',
};

/** 日程时间显示（24 小时制，避免 AM/PM 本地化差异） */
export function fmtWhen(o: Pick<Occurrence, 'start' | 'end' | 'allDay'>, now = new Date()): string {
  const s = new Date(o.start);
  const hm = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const same = s.toDateString() === now.toDateString();
  const day = same ? t('今天') : t('{0}月{1}日', s.getMonth() + 1, s.getDate());
  return o.allDay ? t('{0} 全天', day) : `${day} ${hm(s)}–${hm(new Date(o.end))}`;
}
