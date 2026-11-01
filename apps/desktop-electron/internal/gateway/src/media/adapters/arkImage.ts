/** 火山方舟 Seedream / SeedEdit：POST {base}/images/generations，像素尺寸 + response_format=b64_json + 默认不加水印 */
import type { ImageAdapter } from '../types';
import { arr, dataImages, obj, pixelSizeFor, trimSlash } from '../util';

export const arkImage: ImageAdapter = {
  id: 'ark-image',
  auth: 'bearer',
  // 改图：参考图放 image（data URL 数组），接口不变
  edit: true,
  build: (i) => ({
    method: 'POST',
    url: `${trimSlash(i.baseURL)}/images/generations`,
    body: {
      model: i.model,
      prompt: i.prompt,
      size: pixelSizeFor(i.aspect, 2048),
      response_format: 'b64_json',
      watermark: false,
      sequential_image_generation: 'disabled',
      ...(i.refs?.length ? { image: i.refs.map((r) => `data:${r.mime};base64,${r.b64}`) } : {}),
    },
  }),
  parse: (body) => ({
    kind: 'images',
    images: dataImages(arr(obj(body)?.data)),
  }),
};
