/** OpenRouter 对话出图：POST {base}/chat/completions，modalities 含 image，图片在 message.images[].image_url */
import type { GeneratedImage, ImageAdapter } from '../types';
import { arr, fromDataUrl, obj, str, trimSlash } from '../util';

export const openrouterChatImage: ImageAdapter = {
  id: 'openrouter-chat-image',
  auth: 'bearer',
  // 改图：参考图作为 image_url 内容块
  edit: true,
  build: (i) => ({
    method: 'POST',
    url: `${trimSlash(i.baseURL)}/chat/completions`,
    body: {
      model: i.model,
      modalities: ['image', 'text'],
      ...(i.aspect !== 'auto' ? { image_config: { aspect_ratio: i.aspect } } : {}),
      messages: [
        {
          role: 'user',
          content: i.refs?.length
            ? [
                { type: 'text', text: i.prompt },
                ...i.refs.map((r) => ({
                  type: 'image_url',
                  image_url: { url: `data:${r.mime};base64,${r.b64}` },
                })),
              ]
            : i.prompt,
        },
      ],
    },
  }),
  parse: (body) => {
    const images: GeneratedImage[] = [];
    for (const c of arr(obj(body)?.choices))
      for (const im of arr(obj(c.message)?.images)) {
        const u = str(obj(im.image_url)?.url);
        if (u) images.push(fromDataUrl(u));
      }
    return { kind: 'images', images };
  },
};
