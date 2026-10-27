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
 * 生图客户端：`ai:media:*` IPC。供应商 / Key 复用「模型 → 第三方供应商」的配置，这里只看得到
 * 供应商名与是否可用；图片模型由主进程按打包规则识别，或在供应商设置里标记（markImage）。
 */

export interface MediaProviderView {
  id: string;
  name: string;
  presetId?: string;
  enabled: boolean;
  hasKey: boolean;
}

/** 供应商设置里的手动标记：modelId = 图片模型 schema；null = 不是图片模型 */
export interface ImageMark {
  providerRef: string;
  upstream: string;
  modelId: string | null;
}

export interface MediaState {
  schemaVersion: number;
  models: MediaModelSpec[];
  providers: MediaProviderView[];
  bindings: ProviderBinding[];
  marks: ImageMark[];
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
  /** 生成中进度：已完成批次 / 总批次 */
  progress?: { done: number; total: number };
}

export interface SessionChoice {
  choice: MediaModelChoice | null;
  /** true = 本会话临时改用，不是设置里的默认 */
  override: boolean;
}

/** 已启用且有 Key 的「模型 · 供应商」组合（对话 pill / 工作台下拉共用） */
export function usablePairs(state: MediaState | null): MediaModelChoice[] {
  if (!state) return [];
  const ok = new Set(state.providers.filter((p) => p.enabled && p.hasKey).map((p) => p.id));
  return state.bindings
    .filter((b) => b.enabled && ok.has(b.providerRef))
    .map((b) => ({ modelId: b.modelId, providerRef: b.providerRef }));
}

/** 先选供应商：已启用、有 Key、且至少提供一个可用生图模型的供应商（按设置里的顺序） */
export function choiceProviders(state: MediaState | null): MediaProviderView[] {
  if (!state) return [];
  const known = new Set(state.models.map((m) => m.id));
  return state.providers.filter(
    (p) =>
      p.enabled &&
      p.hasKey &&
      state.bindings.some((b) => b.enabled && b.providerRef === p.id && known.has(b.modelId)),
  );
}

/** 再选模型：该供应商已启用绑定的生图模型 id（按模型目录顺序） */
export function providerModelIds(state: MediaState | null, providerRef: string): string[] {
  if (!state) return [];
  const on = new Set(
    state.bindings.filter((b) => b.enabled && b.providerRef === providerRef).map((b) => b.modelId),
  );
  return state.models.filter((m) => on.has(m.id)).map((m) => m.id);
}

/** 换供应商：新供应商也提供当前模型就保留，否则换成它的第一个模型（无则空串） */
export function modelForProvider(
  state: MediaState | null,
  providerRef: string,
  modelId: string,
): string {
  const ids = providerModelIds(state, providerRef);
  return ids.includes(modelId) ? modelId : (ids[0] ?? '');
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
  /** modelId：标为该图片模型；null：标为不是图片模型；undefined：清除标记，回到自动识别 */
  markImage: (p: { providerRef: string; upstream: string; modelId?: string | null }) =>
    call<{ changes: ChoiceChange[] }>('mark-image', p),
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
  /** 取消排队中 / 生成中的任务 */
  cancel: (taskId: string) => call<boolean>('cancel', taskId),
  /** 失败或取消的任务按原参数重新排队，返回新任务 */
  retry: (taskId: string) => call<MediaTask>('retry', taskId),
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
  /** 彻底删除（文件 + 索引） */
  deleteAssets: (ids: string[]) => call<number>('delete-assets', ids),
  /** 选择目录后导出原图；取消返回 0 */
  exportAssets: (ids: string[]) => call<number>('export-assets', ids),
  sessionChoice: (conversationId?: string) =>
    call<SessionChoice>('session-choice', conversationId ?? ''),
  setSessionChoice: (conversationId: string | undefined, c: MediaModelChoice | null) =>
    call<SessionChoice>('set-session-choice', conversationId ?? '', c),
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

// ---------- 上传图原图登记 ----------
// 会话历史里只存缩略图；本次运行期间发出的上传图在这里记住原图，右键「加入素材库」存原图。
// 重启后旧消息没有原图可取 → 菜单禁用该项，不会把缩略图当原图入库。
const ORIGINALS_MAX = 64;
const originals = new Map<string, string>();

export function rememberOriginal(thumb: string, mime: string, base64: string): void {
  if (!thumb || !base64) return;
  originals.delete(thumb);
  originals.set(thumb, `data:${mime};base64,${base64}`);
  while (originals.size > ORIGINALS_MAX) originals.delete(originals.keys().next().value as string);
}

export function originalOf(thumb: string): string | null {
  return originals.get(thumb) ?? null;
}
