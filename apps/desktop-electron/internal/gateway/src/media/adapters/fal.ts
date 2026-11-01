/** fal.ai：POST {base}/{模型路径}（sync_mode），Authorization: Key …，结果在 images[].url（可能是 data URL） */
import type { GeneratedImage, ImageAdapter, ImageAspect } from '../types';
import { arr, fromDataUrl, obj, str, trimSlash } from '../util';

const SIZE: Partial<Record<ImageAspect, string>> = {
  '1:1': 'square_hd',
  '3:2': 'landscape_4_3',
  '2:3': 'portrait_4_3',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
};

export const fal: ImageAdapter = {
  id: 'fal',
  auth: 'key',
  build: (i) => ({
    method: 'POST',
    url: `${trimSlash(i.baseURL)}/${i.model.replace(/^\/+/, '')}`,
    body: {
      prompt: i.prompt,
      num_images: 1,
      sync_mode: true,
      ...(SIZE[i.aspect] ? { image_size: SIZE[i.aspect] } : {}),
    },
  }),
  parse: (body) => ({
    kind: 'images',
    images: arr(obj(body)?.images)
      .map((im): GeneratedImage | null => {
        const u = str(im.url);
        return u
          ? { ...fromDataUrl(u), ...(str(im.content_type) ? { mime: str(im.content_type) } : {}) }
          : null;
      })
      .filter((x): x is GeneratedImage => !!x),
  }),
};
