/**
 * 阿里云百炼 DashScope 文生图（通义万相 wanx / wan2.x、qwen-image）：异步任务。
 * 提交 POST {站点}/api/v1/services/aigc/text2image/image-synthesis（X-DashScope-Async: enable）→ task_id，
 * 再轮询 GET {站点}/api/v1/tasks/{id} 直到 SUCCEEDED，结果是图片 URL。
 */
import type { GeneratedImage, ImageAdapter, ImageAspect } from '../types';
import { arr, obj, str, trimSlash } from '../util';

const SIZE: Partial<Record<ImageAspect, string>> = {
  '1:1': '1024*1024',
  '3:2': '1440*960',
  '2:3': '960*1440',
  '16:9': '1280*720',
  '9:16': '720*1280',
};
const POLL_MS = 2000;

export const dashscope: ImageAdapter = {
  id: 'dashscope-async',
  auth: 'bearer',
  timeoutMs: 180_000,
  build: (i) => ({
    method: 'POST',
    url: `${trimSlash(i.baseURL)}/api/v1/services/aigc/text2image/image-synthesis`,
    headers: { 'X-DashScope-Async': 'enable' },
    body: {
      model: i.model,
      input: { prompt: i.prompt },
      parameters: { n: 1, ...(SIZE[i.aspect] ? { size: SIZE[i.aspect] } : {}) },
    },
  }),
  parse: (body, i) => {
    const out = obj(obj(body)?.output);
    const status = str(out?.task_status);
    const id = str(out?.task_id);
    if (status === 'SUCCEEDED')
      return {
        kind: 'images',
        images: arr(out?.results).flatMap((r): GeneratedImage[] => {
          const url = str(r.url);
          return url ? [{ url }] : [];
        }),
      };
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN')
      return { kind: 'failed', message: str(out?.message) ?? status };
    if (id)
      return {
        kind: 'poll',
        afterMs: POLL_MS,
        next: {
          method: 'GET',
          url: `${trimSlash(i.baseURL)}/api/v1/tasks/${encodeURIComponent(id)}`,
        },
      };
    return { kind: 'images', images: [] };
  },
};
