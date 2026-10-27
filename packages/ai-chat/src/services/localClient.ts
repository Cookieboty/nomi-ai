import { t } from '@nomi-ai/ui';
/** 本机管理客户端：本机模型（llama.cpp / Ollama）、数据导出（`ai:local:*` / `ai:hub:*`） */
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
  if (!b) throw new Error(t('ui.chat-settings.the-local-hub-requires-the-desktop-app'));
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
  exportAll: (include: string[], conversations?: unknown) =>
    H<{ file: string; bytes: number } | null>('export', { include, conversations }),
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
  ok: 'ui.chat-settings.plenty-of-memory',
  tight: 'ui.chat-settings.memory-is-tight',
  'too-big': 'ui.chat-settings.not-enough-memory',
};
export const STATUS_LABEL: Record<ServerStatus, string> = {
  stopped: 'ui.chat-settings.not-running',
  starting: 'ui.chat-settings.starting',
  running: 'ui.knowledge-local.running',
  error: 'ui.chat-settings.error',
};
