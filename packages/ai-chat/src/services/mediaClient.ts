import type {
  AssetSource,
  MediaModelChoice,
  MediaModelSpec,
  MediaParams,
  MediaPrefs,
  MediaProtocol,
  ProviderBinding,
} from '@nomi-ai/gateway/media';
import { t } from '@nomi-ai/ui';
import { useEffect, useState } from 'react';
/**
 * 生图客户端：`ai:media:*` IPC。生图 Key 只写不读——渲染层只能看到 hasKey / keyHint。
 */

export interface MediaProviderView {
  id: string;
  name: string;
  baseURL: string;
  preset?: string;
  enabled: boolean;
  keyHint?: string;
  hasKey: boolean;
  custom: boolean;
}

export interface MediaState {
  schemaVersion: number;
  models: MediaModelSpec[];
  presets: Array<{ id: string; name: string; baseURL: string }>;
  providers: MediaProviderView[];
  bindings: ProviderBinding[];
  prefs: MediaPrefs;
  localOnly: boolean;
}

export interface MediaAsset {
  id: string;
  sha256: string;
  mime: string;
  ext: string;
  bytes: number;
  createdAt: number;
  addedAt?: number;
  inLibrary: boolean;
  prompt?: string;
  modelId?: string;
  providerRef?: string;
  url: string;
  sources: AssetSource[];
}

export interface MediaTask {
  id: string;
  surface: 'chat' | 'studio';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  modelId: string;
  providerRef: string;
  prompt: string;
  params: MediaParams;
  createdAt: number;
  finishedAt?: number;
  assets: MediaAsset[];
  error?: { code: string; message: string };
}

export interface ChoiceChange {
  target: 'chat' | 'studio';
  kind: 'switched' | 'cleared';
  from: MediaModelChoice;
  to?: MediaModelChoice;
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

export class MediaCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new MediaCallError('unavailable', t('ui.media.desktop-only'));
  const r = (await b.invoke(`ai:media:${method}`, ...args)) as T & {
    __error?: { code: string; message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error)
    throw new MediaCallError(r.__error.code, r.__error.message);
  return r;
}

const on = (ch: string, fn: (p: unknown) => void) => bridge()?.on(ch, fn) ?? (() => undefined);

export const mediaClient = {
  available: () => !!bridge(),
  state: () => call<MediaState>('state'),
  upsertProvider: (p: {
    id?: string;
    name?: string;
    baseURL?: string;
    enabled?: boolean;
    apiKey?: string | null;
  }) => call<{ provider: MediaProviderView; changes: ChoiceChange[] }>('upsert-provider', p),
  removeProvider: (id: string) => call<{ changes: ChoiceChange[] }>('remove-provider', id),
  upsertBinding: (p: {
    providerRef: string;
    modelId: string;
    enabled?: boolean;
    presetKey?: MediaProtocol;
    upstreamModelName?: string;
  }) => call<{ changes: ChoiceChange[] }>('upsert-binding', p),
  removeBinding: (c: MediaModelChoice) => call<{ changes: ChoiceChange[] }>('remove-binding', c),
  setChatDefault: (c: MediaModelChoice | null) => call<MediaPrefs>('set-chat-default', c),
  setPrefs: (p: { autoAddGenerated?: boolean; autoAddUploads?: boolean }) =>
    call<MediaPrefs>('set-prefs', p),
  start: (
    p: MediaModelChoice & {
      prompt: string;
      params: MediaParams;
      refs?: Array<{ assetId: string }>;
    },
  ) => call<MediaTask>('start', p),
  tasks: () => call<MediaTask[]>('tasks'),
  assets: (source?: AssetSource) => call<MediaAsset[]>('assets', source ? { source } : {}),
  lookup: (src: string) => call<MediaAsset | null>('lookup', src),
  addAsset: (src: string, source: AssetSource, conversationId?: string) =>
    call<MediaAsset>('add-asset', src, source, conversationId),
  setInLibrary: (id: string, v: boolean) => call<MediaAsset>('set-in-library', id, v),
  ingestUploads: (images: Array<{ mime: string; data: string }>, conversationId?: string) =>
    call<number>('ingest-uploads', images, conversationId),
  copyImage: (src: string) => call<boolean>('copy-image', src),
  saveImage: (src: string, name?: string) => call<boolean>('save-image', src, name),
  importFiles: () => call<MediaAsset[]>('import'),
  onChanged: (fn: () => void) => on('ai:media:changed', () => fn()),
  onTask: (fn: (task: MediaTask) => void) => on('ai:media:task', (p) => fn(p as MediaTask)),
  onNotice: (fn: (c: ChoiceChange) => void) => on('ai:media:notice', (p) => fn(p as ChoiceChange)),
};

/** 预设名可能是 i18n key（如火山方舟），自定义名原样显示 */
export function displayName(name: string): string {
  return /^ui\.[a-z0-9-]+\.[a-z0-9-]+$/.test(name) ? t(name) : name;
}

export function providerName(state: MediaState | null, id: string): string {
  const p = state?.providers.find((x) => x.id === id);
  return p ? displayName(p.name) : id;
}

export function modelName(state: MediaState | null, id: string): string {
  return state?.models.find((m) => m.id === id)?.name ?? id;
}

/** 订阅生图配置；主进程变化（含自动切换）时刷新 */
export function useMediaState(): [MediaState | null, () => void] {
  const [state, setState] = useState<MediaState | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!mediaClient.available()) return;
    let alive = true;
    void mediaClient
      .state()
      .then((s) => alive && setState(s))
      .catch(() => undefined);
    const off = mediaClient.onChanged(() => setTick((n) => n + 1));
    return () => {
      alive = false;
      off();
    };
  }, [tick]);
  return [state, () => setTick((n) => n + 1)];
}

// 「是否已在素材库」查询缓存：同一个 src 只问一次；库变化时清空
const lookupCache = new Map<string, Promise<MediaAsset | null>>();
let lookupSubscribed = false;
const lookupListeners = new Set<() => void>();

function ensureLookupSubscription(): void {
  if (lookupSubscribed || !mediaClient.available()) return;
  lookupSubscribed = true;
  mediaClient.onChanged(() => {
    lookupCache.clear();
    for (const fn of lookupListeners) fn();
  });
}

export function lookupAsset(src: string): Promise<MediaAsset | null> {
  ensureLookupSubscription();
  let p = lookupCache.get(src);
  if (!p) {
    p = mediaClient.lookup(src).catch(() => null);
    lookupCache.set(src, p);
  }
  return p;
}

export function invalidateLookup(): void {
  lookupCache.clear();
  for (const fn of lookupListeners) fn();
}

/** 图片是否已在素材库（角标 / 右键菜单用） */
export function useAssetInLibrary(src: string | undefined): MediaAsset | null {
  const [asset, setAsset] = useState<MediaAsset | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    lookupListeners.add(fn);
    return () => {
      lookupListeners.delete(fn);
    };
  }, []);
  useEffect(() => {
    if (!src || !mediaClient.available()) return;
    let alive = true;
    void lookupAsset(src).then((a) => alive && setAsset(a));
    return () => {
      alive = false;
    };
  }, [src, tick]);
  return asset && asset.inLibrary ? asset : null;
}

// ───────── 渲染层内部事件（打开工作台 / 素材库 / 设置，显示提示） ─────────

export const MEDIA_OPEN_EVENT = 'nomi:media-open';
export const MEDIA_TOAST_EVENT = 'nomi:media-toast';

export interface MediaOpenDetail {
  target: 'settings' | 'studio' | 'library';
  prompt?: string;
}

export function openMedia(detail: MediaOpenDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<MediaOpenDetail>(MEDIA_OPEN_EVENT, { detail }));
}

export function mediaToast(message: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<string>(MEDIA_TOAST_EVENT, { detail: message }));
}

/** 自动切换 / 清空默认模型时的提示文案 */
export function describeChange(state: MediaState | null, c: ChoiceChange): string {
  const where = c.target === 'chat' ? t('ui.media.target-chat') : t('ui.media.nav-studio');
  const model = modelName(state, c.from.modelId);
  if (c.kind === 'switched' && c.to)
    return t(
      'ui.media.notice-switched',
      where,
      model,
      providerName(state, c.from.providerRef),
      providerName(state, c.to.providerRef),
    );
  return t('ui.media.notice-cleared', where, model);
}
