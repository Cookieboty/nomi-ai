/**
 * OpenAI Images：文生图 POST {base}/images/generations（JSON）；改图 POST {base}/images/edits（multipart，
 * 图片放 image[]）。OpenAI 与各家 OpenAI 兼容中转、硅基流动、xAI … 都是这个形状。
 */
import type { ImageAdapter } from '../types';
import { arr, dataImages, obj, openaiSizeFor, str, trimSlash } from '../util';

export const openaiImages: ImageAdapter = {
  id: 'openai-images',
  auth: 'bearer',
  edit: true,
  build: (i) => {
    const size = openaiSizeFor(i.aspect);
    if (i.refs?.length)
      return {
        method: 'POST',
        url: `${trimSlash(i.baseURL)}/images/edits`,
        multipart: {
          fields: { model: i.model, prompt: i.prompt, n: '1', ...(size ? { size } : {}) },
          files: i.refs.map((r, n) => ({
            field: 'image[]',
            name: `image-${n}.${r.mime.split('/')[1] ?? 'png'}`,
            mime: r.mime,
            b64: r.b64,
          })),
        },
      };
    return {
      method: 'POST',
      url: `${trimSlash(i.baseURL)}/images/generations`,
      body: { model: i.model, prompt: i.prompt, n: 1, ...(size ? { size } : {}) },
    };
  },
  parse: (body) => {
    const data = arr(obj(body)?.data);
    return {
      kind: 'images',
      images: dataImages(data),
      ...(str(data[0]?.revised_prompt) ? { revisedPrompt: str(data[0]?.revised_prompt) } : {}),
    };
  },
};
