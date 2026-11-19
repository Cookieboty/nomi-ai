/**
 * 用户发的图片存进素材库（chatAssets.import）：消息里记下 chat-asset 地址，气泡里可放大看原图、复制、
 * 「以此修改 / 作为参考」；地址也附在发给模型的消息里，Nomi 改图 / 参考时交给 image_generate。
 * 存不进去不挡发送：这张图照常发给模型，只是消息里没有原图地址。
 */
import { createLogger } from '@nomi-ai/ui';

import type { PendingImage } from '../utils/pendingSends';

import { api, hasTransport } from './api';
import type { HarnessImageInput } from './harnessClient';
import type { ImageAttachment } from './screenClient';

const log = createLogger('chat-images');

type ImportMime = ImageAttachment['mime'];
const IMPORT_MIMES = new Set<string>(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** 返回与 images 一一对应的地址（存不进去的是空串） */
export async function importChatImages(
  images: readonly Pick<PendingImage, 'mime' | 'data'>[],
  conversationId: string | undefined,
): Promise<string[]> {
  if (!hasTransport()) return images.map(() => '');
  return Promise.all(
    images.map(async (i) => {
      if (!IMPORT_MIMES.has(i.mime)) return '';
      try {
        const r = await api.chatAssets.import({
          mime: i.mime as ImportMime,
          data: i.data,
          ...(conversationId ? { conversationId } : {}),
        });
        return typeof r?.url === 'string' ? r.url : '';
      } catch (e) {
        log.warn('图片没能存进素材库', e);
        return '';
      }
    }),
  );
}

/** 为缺少 url 的图片补存素材库并转为 HarnessImageInput[]，已有 url 的直接复用 */
export async function ensureHarnessImages(
  images: readonly PendingImage[],
  conversationId?: string,
): Promise<HarnessImageInput[]> {
  if (!images.length) return [];
  const missing = images.filter((i) => !i.url);
  const imported = missing.length ? await importChatImages(missing, conversationId) : [];
  let cursor = 0;
  return images.map((i) => {
    const url = i.url || imported[cursor++] || '';
    return {
      mime: i.mime,
      data: i.data,
      ...(i.width !== undefined ? { width: i.width } : {}),
      ...(i.height !== undefined ? { height: i.height } : {}),
      ...(i.thumb !== undefined ? { thumb: i.thumb } : {}),
      ...(i.source !== undefined ? { source: i.source } : {}),
      ...(url ? { url } : {}),
    };
  });
}

/** agents sendTab 附图：带上素材库原图地址，气泡预览不再只用 240px 缩略图 */
export async function toHarnessImages(
  images: readonly ImageAttachment[],
  conversationId?: string,
): Promise<HarnessImageInput[]> {
  return ensureHarnessImages(images, conversationId);
}
