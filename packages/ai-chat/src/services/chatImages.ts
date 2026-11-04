/**
 * 用户发的图片存进素材库（chatAssets.import）：消息里记下 chat-asset 地址，气泡里可放大看原图、复制、
 * 「以此修改 / 作为参考」；地址也附在发给模型的消息里，Nomi 改图 / 参考时交给 image_generate。
 * 存不进去不挡发送：这张图照常发给模型，只是消息里没有原图地址。
 */
import { createLogger } from '@nomi-ai/ui';

import { api, hasTransport } from './api';
import type { HarnessImageInput } from './harnessClient';
import type { ImageAttachment } from './screenClient';

const log = createLogger('chat-images');

/** 返回与 images 一一对应的地址（存不进去的是空串） */
export async function importChatImages(
  images: readonly ImageAttachment[],
  conversationId: string | undefined,
): Promise<string[]> {
  if (!hasTransport()) return images.map(() => '');
  return Promise.all(
    images.map(async (i) => {
      try {
        const r = await api.chatAssets.import({
          mime: i.mime,
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

/** 编程助手 sendTab 附图：带上素材库原图地址，气泡预览不再只用 240px 缩略图 */
export async function toHarnessImages(
  images: readonly ImageAttachment[],
  conversationId?: string,
): Promise<HarnessImageInput[]> {
  const urls = await importChatImages(images, conversationId);
  return images.map((i, k) => ({
    mime: i.mime,
    data: i.data,
    width: i.width,
    height: i.height,
    thumb: i.thumb,
    source: i.source,
    ...(urls[k] ? { url: urls[k] } : {}),
  }));
}
