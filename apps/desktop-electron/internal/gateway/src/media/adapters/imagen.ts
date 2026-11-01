/** Google Imagen：POST {base}/models/{model}:predict，结果在 predictions[].bytesBase64Encoded */
import type { GeneratedImage, ImageAdapter } from '../types';
import { arr, obj, str, trimSlash } from '../util';

export const imagen: ImageAdapter = {
  id: 'imagen',
  auth: 'x-goog-api-key',
  build: (i) => ({
    method: 'POST',
    url: `${trimSlash(i.baseURL)}/models/${encodeURIComponent(i.model.replace(/^models\//, ''))}:predict`,
    body: {
      instances: [{ prompt: i.prompt }],
      parameters: { sampleCount: 1, ...(i.aspect !== 'auto' ? { aspectRatio: i.aspect } : {}) },
    },
  }),
  parse: (body) => ({
    kind: 'images',
    images: arr(obj(body)?.predictions).flatMap((p): GeneratedImage[] => {
      const b64 = str(p.bytesBase64Encoded);
      return b64 ? [{ b64, ...(str(p.mimeType) ? { mime: str(p.mimeType) } : {}) }] : [];
    }),
  }),
};
