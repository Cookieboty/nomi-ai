import { t } from '@nomi-ai/ui';
/** 截图提问 / 图片附件 / 屏幕记忆客户端：`ai:screen:*` IPC */

export interface ImageAttachment {
  id: string;
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  /** base64，不含 data: 前缀 */
  data: string;
  width: number;
  height: number;
  /** 小缩略图 data URL（存进会话历史，用于显示） */
  thumb: string;
  source: 'snip' | 'screen' | 'paste' | 'file';
}

export interface ScreenMemSettings {
  enabled: boolean;
  intervalSec: number;
  retentionDays: number;
  exclusions: string[];
  pausedUntil: number;
  snipHotkey: boolean;
}

export interface ScreenState {
  settings: ScreenMemSettings;
  active: boolean;
  count: number;
  ocrReady: boolean;
  lastSkip: string;
  chat: { id: string; name: string; local: boolean; model?: string } | null;
  localOnly: boolean;
}

export interface ScreenEntry {
  id: string;
  at: number;
  windows: string[];
  text: string;
  thumbUrl?: string;
}

export interface RawAttachment {
  mime: ImageAttachment['mime'];
  data: string;
  width: number;
  height: number;
  source: ImageAttachment['source'];
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
async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error(t('ui.chat-settings.screenshots-require-the-desktop-app'));
  const r = (await b.invoke(`ai:screen:${method}`, ...args)) as T & {
    __error?: { code: string; message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}
const on = (ch: string, fn: (p: unknown) => void) => bridge()?.on(ch, fn) ?? (() => undefined);

const MAX_SIDE = 1568;
let seq = 0;
const newId = () => `img-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t('ui.chat-settings.couldn-t-decode-the-image')));
    img.src = src;
  });
}

function draw(img: HTMLImageElement, maxSide: number, quality: number) {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error(t('ui.chat-settings.canvas-unavailable'));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { url: c.toDataURL('image/jpeg', quality), w, h };
}

/** data URL → 附件（压到长边 1568、JPEG）+ 缩略图 */
export async function attachmentFromDataUrl(
  url: string,
  source: ImageAttachment['source'],
): Promise<ImageAttachment> {
  const img = await loadImage(url);
  const full = draw(img, MAX_SIDE, 0.85);
  const thumb = draw(img, 240, 0.7);
  return {
    id: newId(),
    mime: 'image/jpeg',
    data: full.url.slice(full.url.indexOf(',') + 1),
    width: full.w,
    height: full.h,
    thumb: thumb.url,
    source,
  };
}

export const MAX_ATTACHMENTS = 4;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function attachmentFromFile(f: File): Promise<ImageAttachment> {
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type))
    throw new Error(t('ui.chat-settings.unsupported-image-format', f.type || f.name));
  if (f.size > MAX_FILE_BYTES) throw new Error(t('ui.chat-settings.image-too-large-max-20-mb'));
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error(t('ui.chat-settings.failed-to-read-image')));
    r.readAsDataURL(f);
  });
  return attachmentFromDataUrl(url, 'paste');
}

export async function fromRaw(r: RawAttachment | null): Promise<ImageAttachment | null> {
  if (!r) return null;
  return attachmentFromDataUrl(`data:${r.mime};base64,${r.data}`, r.source);
}

/** 只用于 UI 提示：模型名看起来是否支持图片 */
export function likelyVision(model: string | undefined): boolean {
  if (!model) return false;
  return /(vision|[-_.]vl\b|vl[-:]|llava|bakllava|moondream|minicpm-v|gpt-4o|gpt-4\.1|gpt-5|\bo3\b|\bo4|claude|gemini|gemma3|qwen2\.5-?vl|qwen3-?vl|pixtral|glm-4v|internvl|mistral-small3)/i.test(
    model,
  );
}

export const screenClient = {
  available: () => !!bridge(),
  state: () => call<ScreenState>('state'),
  setSettings: (p: Partial<ScreenMemSettings>) => call<ScreenMemSettings>('set-settings', p),
  pause: (minutes: number) => call('pause', minutes),
  resume: () => call('resume'),
  snip: async () => fromRaw(await call<RawAttachment | null>('snip')),
  captureFull: async () => fromRaw(await call<RawAttachment>('capture-full')),
  snipSource: () => call<{ url: string; width: number; height: number } | null>('snip-source'),
  snipDone: (
    rect: { x: number; y: number; width: number; height: number } | null,
    view?: { width: number; height: number },
  ) => call('snip-done', rect, view),
  /** 发送图片前：云端告知 / 仅本地模式 */
  checkSend: () => call<'ok' | 'local_only' | 'user_denied'>('check-send'),
  sampleNow: () => call<{ saved: boolean; reason: string }>('sample-now'),
  search: (q: string) => call<ScreenEntry[]>('search', q),
  remove: (id: string) => call<boolean>('remove', id),
  clear: () => call<number>('clear'),
  onChanged: (fn: (s: ScreenState) => void) => on('ai:screen:changed', (p) => fn(p as ScreenState)),
  onAttachment: (fn: (a: ImageAttachment) => void) =>
    on('ai:screen:attachment', (p) => {
      void fromRaw(p as RawAttachment).then((a) => a && fn(a));
    }),
  onOpenPanel: (fn: () => void) => on('ai:screen:open-panel', () => fn()),
};

export const SKIP_REASONS: Record<string, string> = {
  off: 'ui.chat-settings.off',
  busy: 'ui.chat-settings.previous-frame-still-processing',
  'ocr-missing': 'ui.chat-settings.ocr-language-data-not-downloaded-yet-knowledge-base',
  idle: 'ui.chat-settings.computer-idle-skipped',
  unchanged: 'ui.chat-settings.screen-unchanged',
  'no-text': 'ui.chat-settings.no-recognizable-text-on-screen',
  error: 'ui.chat-settings.sampling-error',
};
export function describeSkip(r: string): string {
  if (r.startsWith('excluded:'))
    return t('ui.chat-settings.excluded-window-detected-skipped', r.slice(9));
  return SKIP_REASONS[r] ?? r;
}
