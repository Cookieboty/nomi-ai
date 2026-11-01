import type { GeneratedImage, ImageAspect } from './types';

export type Json = Record<string, unknown>;
export const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
export const arr = (v: unknown): Json[] =>
  Array.isArray(v) ? (v.filter((x) => obj(x)) as Json[]) : [];
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
export const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** data:image/png;base64,xxx → { mime, b64 }；不是 data URL 就当公网地址 */
export function fromDataUrl(u: string): { b64?: string; url?: string; mime?: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(u);
  return m ? { mime: m[1], b64: m[2] } : { url: u };
}

export function ratioOf(a: ImageAspect): [number, number] | null {
  const m = /^(\d+):(\d+)$/.exec(a);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** OpenAI Images 只接受三种尺寸：按画幅取最接近的 */
export function openaiSizeFor(a: ImageAspect): string | undefined {
  const r = ratioOf(a);
  if (!r) return undefined;
  if (r[0] === r[1]) return '1024x1024';
  return r[0] > r[1] ? '1536x1024' : '1024x1536';
}

/** 按长边档位（约 1K / 2K 正方形面积）与画幅合成像素尺寸，取 64 的倍数；sep 为分隔符 */
export function pixelSizeFor(a: ImageAspect, edge: number, sep = 'x'): string {
  const r = ratioOf(a) ?? [1, 1];
  const area = edge * edge;
  const w = Math.sqrt((area * r[0]) / r[1]);
  const h = area / w;
  const snap = (x: number) => Math.max(64, Math.round(x / 64) * 64);
  return `${snap(w)}${sep}${snap(h)}`;
}

/** 上游错误正文里的可读信息 */
export function upstreamErrorMessage(body: unknown): string | undefined {
  const j = obj(body);
  const e = j?.error;
  if (typeof e === 'string') return e;
  if (typeof obj(e)?.message === 'string') return obj(e)!.message as string;
  if (typeof j?.detail === 'string') return j.detail;
  if (typeof j?.message === 'string') return j.message;
  return undefined;
}

/** OpenAI 形状的 data[]：b64_json 或 url */
export function dataImages(data: Json[]): GeneratedImage[] {
  const out: GeneratedImage[] = [];
  for (const d of data) {
    const b64 = str(d.b64_json);
    const url = str(d.url);
    if (b64) out.push({ b64 });
    else if (url) out.push({ url });
  }
  return out;
}
