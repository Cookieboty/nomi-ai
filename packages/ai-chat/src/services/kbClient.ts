import { t } from '@nomi-ai/ui';

import { api, hasTransport } from './api';
import { contractErrorCode } from './hostBackends/knowledge';
/**
 * 本地知识库客户端：契约 `kb.*`（docs/design/core-host-decoupling.md §12 P1b，原 `ai:kb:*`）。
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

export class KbCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 契约错误码 → 旧码（`KB_LOCAL_ONLY` → `local_only`，`UNAVAILABLE` → `unavailable`），调用方照旧判断 */
const LEGACY_CODE: Record<string, string> = {
  UNAVAILABLE: 'unavailable',
  KB_DENIED: 'denied',
  KB_EMPTY: 'empty',
  KB_LOCAL_ONLY: 'local_only',
  KB_USER_DENIED: 'user_denied',
  KB_OCR_MISSING: 'ocr_missing',
};

async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!hasTransport())
    throw new KbCallError(
      'unavailable',
      t('ui.chat-settings.the-knowledge-base-requires-the-desktop-app'),
    );
  try {
    return (await run()) as T;
  } catch (err) {
    const code = contractErrorCode(err);
    if (code !== undefined)
      throw new KbCallError(LEGACY_CODE[code] ?? code, (err as Error).message);
    throw err;
  }
}

const on = (subscribe: () => () => void): (() => void) =>
  hasTransport() ? subscribe() : () => undefined;

export const kbClient = {
  available: () => hasTransport(),
  state: () => call<KbState>(() => api.kb.state()),
  docs: (sourceId: string, filter = '') =>
    call<KbDocView[]>(() => api.kb.docs({ sourceId, filter })),
  addFolder: () => call<KbSourceView | null>(() => api.kb.addFolder()),
  removeSource: (id: string) => call<boolean>(() => api.kb.removeSource({ id })),
  toggleSource: (id: string, enabled: boolean) =>
    call<boolean>(() => api.kb.toggleSource({ id, enabled })),
  setSettings: (p: Partial<KbSettingsView>) =>
    // KbModelRef 是 interface（无索引签名），与 looseObject 的入参类型不直接兼容；形状由契约校验
    call<KbSettingsView>(() => api.kb.setSettings(p as Parameters<typeof api.kb.setSettings>[0])),
  consentCloud: (providerId: string) => call<boolean>(() => api.kb.consentCloud({ providerId })),
  test: (kind: 'embed' | 'rerank') =>
    call<{ ok: boolean; message: string }>(() => api.kb.test({ kind })),
  reindex: (force = false) => call<KbProgress>(() => api.kb.reindex({ force })),
  cancel: () => call<boolean>(() => api.kb.cancel()),
  clear: () => call<boolean>(() => api.kb.clear()),
  search: (q: string) => call<{ hits: KbHit[]; mode: string }>(() => api.kb.search({ q })),
  ask: (q: string, history: Array<{ role: string; content: string }>) =>
    call<{ answer: string; sources: KbSource[]; mode: string }>(() => api.kb.ask({ q, history })),
  open: (docId: string, how: 'open' | 'reveal' = 'open') =>
    call<{ ok: boolean; error?: string }>(() => api.kb.open({ docId, how })),
  ocrDownload: (id: string) =>
    call<{ ok: boolean; error?: string }>(() => api.kb.ocrDownload({ id })),
  ocrCancel: (id: string) => call<boolean>(() => api.kb.ocrCancel({ id })),
  ocrRemove: (id: string) => call<boolean>(() => api.kb.ocrRemove({ id })),
  onChanged: (fn: () => void) => on(() => api.on('kb.changed', () => fn())),
  onProgress: (fn: (p: KbProgress) => void) =>
    on(() => api.on('kb.progress', (p) => fn(p as KbProgress))),
  onDownload: (
    fn: (p: { id: string; received: number; total: number; phase: string; error?: string }) => void,
  ) => on(() => api.on('kb.download', (p) => fn(p))),
};

export const fmtBytes = (n: number) =>
  n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** 显示用：Windows / POSIX 路径都只取最后两级 */
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}
