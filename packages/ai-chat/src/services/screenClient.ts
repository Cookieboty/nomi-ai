import { t } from '@nomi-ai/ui';

import { api, hasTransport } from './api';
/** 图片附件（粘贴 / 拖入）与发送前检查：契约 `screen.checkSend`（原 `ai:screen:check-send`） */

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

async function call<T>(run: () => Promise<T>): Promise<T> {
  if (!hasTransport())
    throw new Error(t('ui.chat-settings.sending-images-requires-the-desktop-app'));
  return run();
}

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

/** 只用于 UI 提示：模型名看起来是否支持图片 */
export function likelyVision(model: string | undefined): boolean {
  if (!model) return false;
  // grok-3 只认文字，grok-4 起能看图；o1-mini / o1-preview 不能看图
  return /(vision|[-_.]vl\b|vl[-:]|llava|bakllava|moondream|minicpm-v|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|\bo1\b(?!-mini|-preview)|\bo3\b|\bo4|claude|opus|sonnet|haiku|gemini|gemma3|grok-?[4-9]|llama-?4|qwen2\.5-?vl|qwen3-?vl|pixtral|glm-4(\.\d+)?v|internvl|mistral-small3)/i.test(
    model,
  );
}

export const screenClient = {
  available: () => hasTransport(),
  /** 发送图片前：云端告知 / 仅本地模式 */
  checkSend: () => call<'ok' | 'local_only' | 'user_denied'>(() => api.screen.checkSend()),
};
