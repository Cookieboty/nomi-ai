/**
 * 协议 preset：把「模型 + 已夹取的参数 + 参考图」组装成上游 HTTP 请求，并把响应解析成图片列表。
 * 纯函数（不发网络）：主进程负责 fetch，Key 只在主进程拼进请求头。
 */
import type { MediaParams, MediaProtocol } from './types';

export interface RefImage {
  mime: string;
  /** base64（不带 data: 前缀） */
  data: string;
}

export interface GenerateInput {
  protocol: MediaProtocol;
  baseURL: string;
  apiKey: string;
  upstreamModel: string;
  prompt: string;
  params: MediaParams;
  refs?: RefImage[];
}

export type RequestBody =
  | { kind: 'json'; json: unknown }
  | {
      kind: 'multipart';
      fields: Record<string, string>;
      files: Array<{ field: string; name: string; mime: string; data: string }>;
    };

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: RequestBody;
}

export interface GeneratedImage {
  /** base64 原图；或 url（需要再下载） */
  b64?: string;
  url?: string;
  mime?: string;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

function ratioOf(v: unknown): [number, number] | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d+):(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** OpenAI Images 只接受三种尺寸：由比例合成 */
export function openaiSizeFor(aspect: unknown): string {
  const r = ratioOf(aspect);
  if (!r) return 'auto';
  if (r[0] === r[1]) return '1024x1024';
  return r[0] > r[1] ? '1536x1024' : '1024x1536';
}

/** 按分辨率档位（长边约 1K/2K/4K 的正方形面积）与比例合成像素尺寸，取 64 的倍数 */
export function pixelSizeFor(resolution: unknown, aspect: unknown): string {
  const edge = resolution === '4K' ? 4096 : resolution === '1K' ? 1024 : 2048;
  const r = ratioOf(aspect) ?? [1, 1];
  const area = edge * edge;
  const w = Math.sqrt((area * r[0]) / r[1]);
  const h = area / w;
  const snap = (x: number) => Math.max(64, Math.round(x / 64) * 64);
  return `${snap(w)}x${snap(h)}`;
}

const FAL_SIZE: Record<string, string> = {
  '1:1': 'square_hd',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
};

function pick(params: MediaParams, keys: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of keys) if (params[k] !== undefined) o[k] = params[k];
  return o;
}

/**
 * 各协议单次请求最多返回几张图。超过时主进程拆成多次请求再合并
 * （Gemini / OpenRouter 对话出图一次只给 1 张）。
 */
export const PROTOCOL_MAX_IMAGES: Record<MediaProtocol, number> = {
  'openai-images': 10,
  'ark-image': 15,
  fal: 4,
  gemini: 1,
  'openrouter-chat-image': 1,
};

/** 把请求的张数按协议上限切成若干批，例如 n=4、上限 1 → [1,1,1,1] */
export function splitImageCount(protocol: MediaProtocol, n: unknown): number[] {
  const total = typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  const per = Math.max(1, PROTOCOL_MAX_IMAGES[protocol] ?? 1);
  const out: number[] = [];
  for (let left = total; left > 0; left -= per) out.push(Math.min(per, left));
  return out;
}

export function buildRequest(input: GenerateInput): BuiltRequest {
  const base = trimSlash(input.baseURL);
  const { params, prompt, upstreamModel: model, apiKey } = input;
  const refs = input.refs ?? [];
  const bearer = { authorization: `Bearer ${apiKey}` };
  switch (input.protocol) {
    case 'openai-images': {
      const fields = {
        model,
        prompt,
        size: openaiSizeFor(params.aspect_ratio),
        ...pick(params, ['n', 'quality', 'background', 'output_format']),
        ...(params.output_format && params.output_format !== 'png'
          ? pick(params, ['output_compression'])
          : {}),
      };
      if (refs.length) {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(fields)) flat[k] = String(v);
        return {
          url: `${base}/images/edits`,
          headers: bearer,
          body: {
            kind: 'multipart',
            fields: flat,
            files: refs.map((r, i) => ({
              field: 'image[]',
              name: `ref-${i}.${r.mime.split('/')[1] ?? 'png'}`,
              mime: r.mime,
              data: r.data,
            })),
          },
        };
      }
      return {
        url: `${base}/images/generations`,
        headers: { ...bearer, 'content-type': 'application/json' },
        body: { kind: 'json', json: fields },
      };
    }
    case 'gemini': {
      const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE'] };
      if (params.aspect_ratio) generationConfig.imageConfig = { aspectRatio: params.aspect_ratio };
      if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
      if (params.seed !== undefined) generationConfig.seed = params.seed;
      return {
        url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: {
          kind: 'json',
          json: {
            contents: [
              {
                role: 'user',
                parts: [
                  ...refs.map((r) => ({ inline_data: { mime_type: r.mime, data: r.data } })),
                  { text: prompt },
                ],
              },
            ],
            generationConfig,
          },
        },
      };
    }
    case 'ark-image': {
      const n = typeof params.n === 'number' ? params.n : 1;
      return {
        url: `${base}/images/generations`,
        headers: { ...bearer, 'content-type': 'application/json' },
        body: {
          kind: 'json',
          json: {
            model,
            prompt,
            size: pixelSizeFor(params.resolution, params.aspect_ratio),
            response_format: 'b64_json',
            watermark: params.watermark === true,
            ...(refs.length ? { image: refs.map((r) => `data:${r.mime};base64,${r.data}`) } : {}),
            ...(n > 1
              ? {
                  sequential_image_generation: 'auto',
                  sequential_image_generation_options: { max_images: n },
                }
              : { sequential_image_generation: 'disabled' }),
          },
        },
      };
    }
    case 'openrouter-chat-image': {
      return {
        url: `${base}/chat/completions`,
        headers: { ...bearer, 'content-type': 'application/json' },
        body: {
          kind: 'json',
          json: {
            model,
            modalities: ['image', 'text'],
            ...(params.aspect_ratio ? { image_config: { aspect_ratio: params.aspect_ratio } } : {}),
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  ...refs.map((r) => ({
                    type: 'image_url',
                    image_url: { url: `data:${r.mime};base64,${r.data}` },
                  })),
                ],
              },
            ],
          },
        },
      };
    }
    case 'fal': {
      const json: Record<string, unknown> = {
        prompt,
        image_size: FAL_SIZE[String(params.aspect_ratio)] ?? 'square_hd',
        num_images: typeof params.n === 'number' ? params.n : 1,
        sync_mode: true,
        ...pick(params, ['seed', 'prompt_upsampling']),
      };
      if (params.safety_tolerance !== undefined)
        json.safety_tolerance = String(params.safety_tolerance);
      return {
        url: `${base}/${model.replace(/^\/+/, '')}`,
        headers: { authorization: `Key ${apiKey}`, 'content-type': 'application/json' },
        body: { kind: 'json', json },
      };
    }
  }
}

function fromDataUrl(u: string): GeneratedImage {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(u);
  return m ? { mime: m[1], b64: m[2] } : { url: u };
}

type Json = Record<string, unknown>;
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

/** 解析上游响应；取不到图片时返回空数组（由调用方报错） */
export function parseResponse(protocol: MediaProtocol, body: unknown): GeneratedImage[] {
  const j = (body ?? {}) as Json;
  switch (protocol) {
    case 'openai-images':
    case 'ark-image':
      return arr(j.data)
        .map((d): GeneratedImage | null =>
          typeof d.b64_json === 'string'
            ? { b64: d.b64_json }
            : typeof d.url === 'string'
              ? { url: d.url }
              : null,
        )
        .filter((x): x is GeneratedImage => !!x);
    case 'gemini': {
      const out: GeneratedImage[] = [];
      for (const c of arr(j.candidates))
        for (const p of arr((c.content as Json | undefined)?.parts)) {
          const d = (p.inlineData ?? p.inline_data) as Json | undefined;
          if (d && typeof d.data === 'string')
            out.push({ b64: d.data, mime: String(d.mimeType ?? d.mime_type ?? 'image/png') });
        }
      return out;
    }
    case 'openrouter-chat-image': {
      const out: GeneratedImage[] = [];
      for (const c of arr(j.choices))
        for (const im of arr((c.message as Json | undefined)?.images)) {
          const u = (im.image_url as Json | undefined)?.url;
          if (typeof u === 'string') out.push(fromDataUrl(u));
        }
      return out;
    }
    case 'fal':
      return arr(j.images)
        .map((im): GeneratedImage | null =>
          typeof im.url === 'string'
            ? {
                ...fromDataUrl(im.url),
                ...(im.content_type ? { mime: String(im.content_type) } : {}),
              }
            : null,
        )
        .filter((x): x is GeneratedImage => !!x);
  }
}

/** 从上游错误响应里取可读信息 */
export function upstreamErrorMessage(body: unknown): string | undefined {
  const j = (body ?? {}) as Json;
  const e = j.error as Json | string | undefined;
  if (typeof e === 'string') return e;
  if (e && typeof e.message === 'string') return e.message;
  if (typeof j.detail === 'string') return j.detail;
  if (typeof j.message === 'string') return j.message;
  return undefined;
}
