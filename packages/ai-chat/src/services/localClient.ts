import { t } from '@nomi-ai/ui';

import { api, hasTransport } from './api';
import { plainError } from './hostBackends/knowledge';
/**
 * 本机管理客户端：本机模型（llama.cpp / Ollama）、数据导出——契约 `local.*` / `hub.*`
 * （docs/design/core-host-decoupling.md §12 P1b，原 `ai:local:*` / `ai:hub:*`）
 */
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
async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!hasTransport())
    throw new Error(t('ui.chat-settings.the-local-hub-requires-the-desktop-app'));
  try {
    return (await run()) as T;
  } catch (err) {
    throw plainError(err);
  }
}
const on = (subscribe: () => () => void): (() => void) =>
  hasTransport() ? subscribe() : () => undefined;

export const localClient = {
  available: () => hasTransport(),
  state: () => call<LocalState>(() => api.local.state()),
  setSettings: (p: Partial<LocalState['settings']>) => call(() => api.local.setSettings(p)),
  download: (id: string) => call<{ ok: boolean; error?: string }>(() => api.local.download({ id })),
  downloadRuntime: () => call<{ ok: boolean; error?: string }>(() => api.local.downloadRuntime()),
  cancel: (id: string) => call(() => api.local.cancel({ id })),
  remove: (id: string) => call(() => api.local.remove({ id })),
  removeRuntime: () => call(() => api.local.removeRuntime()),
  start: (id: string) =>
    call<{ baseURL: string; providerId: string }>(() => api.local.start({ id })),
  stop: () => call(() => api.local.stop()),
  use: () => call(() => api.local.use()),
  offline: (v: boolean) => call(() => api.local.offline({ enabled: v })),
  ollamaList: () => call<OllamaModel[]>(() => api.local.ollamaList()),
  ollamaPull: (n: string) => call(() => api.local.ollamaPull({ name: n })),
  ollamaDelete: (n: string) => call(() => api.local.ollamaDelete({ name: n })),
  onChanged: (fn: () => void) => on(() => api.on('local.changed', () => fn())),
  onProgress: (fn: (p: Progress & { id: string }) => void) =>
    on(() => api.on('local.progress', (p) => fn(p))),
};

export const hubClient = {
  exportAll: (include: string[], conversations?: unknown) =>
    call<{ file: string; bytes: number } | null>(() => api.hub.export({ include, conversations })),
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
