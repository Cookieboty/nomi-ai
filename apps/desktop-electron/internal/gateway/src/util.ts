/** 协议转换共用的小工具：宽松读取未知 JSON */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Obj = Record<string, unknown>;

export function asObj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

export function asArr(v: unknown): Obj[] {
  return Array.isArray(v) ? (v as unknown[]).map(asObj) : [];
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 工具参数（字符串或对象）→ 对象；空串为 {}，非对象包成 {value}，解析失败保留在 {_raw} */
export function parseArgs(v: unknown): Json {
  if (v && typeof v === 'object') return v as Json;
  if (typeof v !== 'string' || !v.trim()) return {};
  try {
    const p: unknown = JSON.parse(v);
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Json) : { value: p as Json };
  } catch {
    return { _raw: v };
  }
}

/** IR 里的工具参数是 JSON 字符串；编码成对象形式（Messages input / Gemini args）时用 */
export function argsObject(args: string | undefined): Json {
  if (!args || !args.trim()) return {};
  try {
    return JSON.parse(args) as Json;
  } catch {
    return { _raw: args };
  }
}

export const EMPTY_SCHEMA: Json = { type: 'object', properties: {} };

/** Codex 自由文本（custom）工具转成函数时的参数形状 */
export const CUSTOM_TOOL_SCHEMA: Json = {
  type: 'object',
  properties: { input: { type: 'string' } },
  required: ['input'],
};

/** Messages 必填 max_tokens：入口没给时的默认值 */
export const DEFAULT_MAX_TOKENS = 8192;

/** data: URL → base64 图片；其他当作普通 URL */
export function parseDataUrl(u: string): { mediaType?: string; data?: string; url?: string } {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$/.exec(u);
  if (m) return { mediaType: m[1] || 'image/png', data: m[2] };
  return { url: u };
}

export function toDataUrl(r: { mediaType?: string; data?: string; url?: string }): string {
  return r.data !== undefined
    ? `data:${r.mediaType ?? 'image/png'};base64,${r.data}`
    : (r.url ?? '');
}
