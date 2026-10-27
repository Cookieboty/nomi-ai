import { t } from '@nomi-ai/ui';
/**
 * 本地知识库客户端：`ai:kb:*` IPC（经 preload 的 window.aiIPC）。
 * 文件夹一律由主进程弹系统选择框加入；渲染层拿不到 key，也不能直接传路径授权。
 */
export interface KbSourceView {
  id: string;
  kind: 'folder';
  path?: string;
  addedAt: number;
  enabled: boolean;
  docs: number;
  chunks: number;
  errors: number;
  lastIndexed: number;
}

export interface KbModelRef {
  enabled: boolean;
  providerId: string;
  model: string;
}

export interface KbSettingsView {
  embed: KbModelRef;
  rerank: KbModelRef;
  ocr: { enabled: boolean; langs: string[] };
  cloudConsent: string[];
  topK: number;
}

export interface KbProgress {
  running: boolean;
  phase: 'scan' | 'index' | 'done' | 'cancelled' | 'error' | 'idle';
  done: number;
  total: number;
  current?: string;
  added: number;
  updated: number;
  removed: number;
  failed: number;
  error?: string;
}

export interface KbOcrAsset {
  id: string;
  lang: string;
  name: string;
  description: string;
  bytes: number;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  installed: boolean;
  downloading: { received: number; total: number } | null;
}

export interface KbState {
  settings: KbSettingsView;
  sources: KbSourceView[];
  stats: { docs: number; chunks: number; vectors: number; errors: number };
  progress: KbProgress;
  embedStatus: { active: boolean; reason?: string };
  localOnly: boolean;
  providers: Array<{ id: string; name: string; baseURL: string; local: boolean }>;
  ocr: KbOcrAsset[];
}

export interface KbDocView {
  id: string;
  path: string;
  title: string;
  ext: string;
  status: 'ok' | 'error' | 'empty';
  error?: string;
  chunks: number;
  ocr: boolean;
  vectors: boolean;
  indexedAt: number;
  size: number;
}

export interface KbHit {
  chunkId: string;
  docId: string;
  path: string;
  title: string;
  page?: number;
  text: string;
  score: number;
}

export interface KbSource {
  n: number;
  docId: string;
  chunkId: string;
  path: string;
  title: string;
  page?: number;
  snippet: string;
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

export class KbCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b)
    throw new KbCallError(
      'unavailable',
      t('ui.chat-settings.the-knowledge-base-requires-the-desktop-app'),
    );
  const r = (await b.invoke(`ai:kb:${method}`, ...args)) as T & {
    __error?: { code: string; message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error)
    throw new KbCallError(r.__error.code, r.__error.message);
  return r;
}

const on = (ch: string, fn: (p: unknown) => void) => bridge()?.on(ch, fn) ?? (() => undefined);

export const kbClient = {
  available: () => !!bridge(),
  state: () => call<KbState>('state'),
  docs: (sourceId: string, filter = '') => call<KbDocView[]>('docs', sourceId, filter),
  addFolder: () => call<KbSourceView | null>('add-folder'),
  removeSource: (id: string) => call<boolean>('remove-source', id),
  toggleSource: (id: string, enabled: boolean) => call<boolean>('toggle-source', id, enabled),
  setSettings: (p: Partial<KbSettingsView>) => call<KbSettingsView>('set-settings', p),
  consentCloud: (providerId: string) => call<boolean>('consent-cloud', providerId),
  test: (kind: 'embed' | 'rerank') => call<{ ok: boolean; message: string }>('test', kind),
  reindex: (force = false) => call<KbProgress>('reindex', force),
  cancel: () => call<boolean>('cancel'),
  clear: () => call<boolean>('clear'),
  search: (q: string) => call<{ hits: KbHit[]; mode: string }>('search', q),
  ask: (q: string, history: Array<{ role: string; content: string }>) =>
    call<{ answer: string; sources: KbSource[]; mode: string }>('ask', q, history),
  open: (docId: string, how: 'open' | 'reveal' = 'open') =>
    call<{ ok: boolean; error?: string }>('open', docId, how),
  ocrDownload: (id: string) => call<{ ok: boolean; error?: string }>('ocr-download', id),
  ocrCancel: (id: string) => call<boolean>('ocr-cancel', id),
  ocrRemove: (id: string) => call<boolean>('ocr-remove', id),
  onChanged: (fn: () => void) => on('ai:kb:changed', () => fn()),
  onProgress: (fn: (p: KbProgress) => void) => on('ai:kb:progress', (p) => fn(p as KbProgress)),
  onDownload: (
    fn: (p: { id: string; received: number; total: number; phase: string; error?: string }) => void,
  ) => on('ai:kb:download', (p) => fn(p as never)),
};

export const fmtBytes = (n: number) =>
  n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** 显示用：Windows / POSIX 路径都只取最后两级 */
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}
