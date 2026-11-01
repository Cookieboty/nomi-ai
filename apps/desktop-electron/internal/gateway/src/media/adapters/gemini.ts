/** Gemini 原生生图：POST {base}/models/{model}:generateContent，要求图片输出，结果在 inlineData */
import type { GeneratedImage, ImageAdapter } from '../types';
import { arr, obj, str, trimSlash } from '../util';

export const gemini: ImageAdapter = {
  id: 'gemini',
  auth: 'x-goog-api-key',
  // 改图：参考图作为 inline_data 放在文字前面，接口不变
  edit: true,
  build: (i) => ({
    method: 'POST',
    url: `${trimSlash(i.baseURL)}/models/${encodeURIComponent(i.model.replace(/^models\//, ''))}:generateContent`,
    body: {
      contents: [
        {
          role: 'user',
          parts: [
            ...(i.refs ?? []).map((r) => ({ inline_data: { mime_type: r.mime, data: r.b64 } })),
            { text: i.prompt },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...(i.aspect !== 'auto' ? { imageConfig: { aspectRatio: i.aspect } } : {}),
      },
    },
  }),
  parse: (body) => {
    const images: GeneratedImage[] = [];
    for (const c of arr(obj(body)?.candidates))
      for (const p of arr(obj(c.content)?.parts)) {
        const d = obj(p.inlineData) ?? obj(p.inline_data);
        const data = str(d?.data);
        if (data) images.push({ b64: data, mime: str(d?.mimeType) ?? str(d?.mime_type) });
      }
    return { kind: 'images', images };
  },
};
