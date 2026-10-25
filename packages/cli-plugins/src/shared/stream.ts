/**
 * 各 CLI 流式输出解析共用的小工具（docs/design/cli-plugin-architecture.md §5.4）：图片 / 内容块取文本、
 * 工具参数与输出转字符串、用量字段、子代理用量。从主进程 cli/streamParse.ts 搬来。
 */
import type { HarnessEvent, HarnessUsage } from '@nomi-ai/cli-sdk';

export const MAX_INPUT_STR = 2000;
export const MAX_OUTPUT = 6000;
export const MAX_THINKING = 8000;

/**
 * 各 CLI 的图片结果可能放在 rawOutput / content 里的多种字段中：
 * data URL、image_url.url、b64_json，或 Anthropic 风格的 image source。
 * 统一转成 Markdown data URL，让现有会话渲染器直接交给 <img> 展示。
 */
export function imageRefs(
  value: unknown,
  out: string[] = [],
  depth = 0,
  allowHttps = true,
): string[] {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    if (/^data:image\/[\w.+-]+;base64,/i.test(value) || (allowHttps && /^https:\/\//i.test(value)))
      out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) imageRefs(item, out, depth + 1, allowHttps);
    return out;
  }
  if (typeof value !== 'object') return out;
  const obj = value as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';
  const source =
    obj.source && typeof obj.source === 'object'
      ? (obj.source as Record<string, unknown>)
      : undefined;
  const mediaType =
    typeof obj.media_type === 'string'
      ? obj.media_type
      : typeof obj.mime_type === 'string'
        ? obj.mime_type
        : typeof source?.media_type === 'string'
          ? source.media_type
          : 'image/png';
  const b64 =
    typeof obj.b64_json === 'string'
      ? obj.b64_json
      : typeof obj.base64 === 'string'
        ? obj.base64
        : typeof obj.data === 'string' &&
            (type.includes('image') || typeof obj.media_type === 'string')
          ? obj.data
          : source && typeof source.data === 'string'
            ? source.data
            : undefined;
  if (b64 && /^[a-z0-9+/=\r\n]+$/i.test(b64))
    out.push(`data:${mediaType};base64,${b64.replace(/\s+/g, '')}`);
  const url =
    obj.url ??
    (obj.image_url && typeof obj.image_url === 'object'
      ? (obj.image_url as Record<string, unknown>).url
      : obj.image_url);
  if (
    typeof url === 'string' &&
    (/^data:image\//i.test(url) || (allowHttps && /^https:\/\//i.test(url)))
  )
    out.push(url);
  if (source) imageRefs(source, out, depth + 1, allowHttps);
  // Only recurse into explicitly image-shaped containers; arbitrary `data` text is common.
  if (
    type.includes('image') ||
    type.includes('photo') ||
    obj.images !== undefined ||
    obj.generated_images !== undefined
  ) {
    imageRefs(
      obj.images ?? obj.generated_images ?? obj.data ?? obj.content,
      out,
      depth + 1,
      allowHttps ||
        obj.images !== undefined ||
        obj.generated_images !== undefined ||
        type.includes('image'),
    );
  }
  return out;
}

export function imageMarkdown(value: unknown, allowHttps = true): string {
  const refs = [...new Set(imageRefs(value, [], 0, allowHttps))];
  return refs.map((url, i) => `![Generated image ${i + 1}](${url})`).join('\n\n');
}

export function textWithImage(text: string, image: string): string {
  return image ? (text ? `${text}\n\n${image}` : image) : text;
}

/** 从各家内容块中取出可见文本；图片块由 imageMarkdown 单独处理。 */
export function blockText(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((x) => blockText(x, depth + 1))
      .filter(Boolean)
      .join('');
  if (typeof value !== 'object') return '';
  const o = value as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : '';
  if (type === 'text' || type === 'output_text' || type === 'input_text')
    return typeof o.text === 'string' ? o.text : '';
  for (const key of ['content', 'parts', 'output', 'result']) {
    if (o[key] !== undefined) {
      const text = blockText(o[key], depth + 1);
      if (text) return text;
    }
  }
  return '';
}

export function imageEvent(
  value: unknown,
  allowHttps = true,
  assumeBase64 = false,
): HarnessEvent[] {
  const candidate =
    assumeBase64 &&
    typeof value === 'string' &&
    !/^data:image\//i.test(value) &&
    !/^https:\/\//i.test(value)
      ? { b64_json: value }
      : value;
  const image = imageMarkdown(candidate, allowHttps);
  return image ? [{ type: 'text-delta', text: `${image}\n\n` }] : [];
}

export const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}\n… (+${s.length - n})` : s;

/** 递归裁剪对象里的长字符串（保持 JSON 仍然合法），并限制深度 / 数组长度 */
export function clipDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return clip(v, MAX_INPUT_STR);
  if (depth > 5 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clipDeep(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40))
    out[k] = clipDeep(x, depth + 1);
  return out;
}

/** 工具参数 → 字符串（字符串原样裁剪，对象序列化为合法 JSON）；空值返回 undefined */
export function inputText(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string') return clip(v, MAX_INPUT_STR);
  if (typeof v !== 'object') return String(v);
  if (!Array.isArray(v) && Object.keys(v as object).length === 0) return undefined;
  try {
    return JSON.stringify(clipDeep(v));
  } catch {
    return undefined;
  }
}

/** 工具输出 → 字符串：字符串 / 内容块数组（取 text）/ 其它对象序列化 */
export function outputText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  let s: string;
  if (typeof v === 'string') s = v;
  else if (Array.isArray(v)) {
    s = v
      .map((c) =>
        c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
          ? (c as { text: string }).text
          : typeof c === 'string'
            ? c
            : '',
      )
      .filter(Boolean)
      .join('\n');
    if (!s) return undefined;
  } else if (typeof v === 'object') {
    try {
      s = JSON.stringify(v);
    } catch {
      return undefined;
    }
  } else s = String(v);
  return s ? clip(s, MAX_OUTPUT) : undefined;
}

export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/**
 * 各 CLI 上报的用量 → HarnessUsage（兼容 snake_case / camelCase；没有任何数据时返回 undefined）。
 * Claude: usage.{input,output,cache_read_input}_tokens + total_cost_usd + duration_ms；
 * Codex: usage.{input,cached_input,output}_tokens；Grok: usage 对象（camelCase）。
 */
export function parseUsage(
  usage: unknown,
  extra: { costUsd?: unknown; durationMs?: unknown } = {},
): HarnessUsage | undefined {
  const u = usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = num(u[k]);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const out: HarnessUsage = {};
  const input = pick('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens');
  const output = pick('output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens');
  const cache = pick(
    'cache_read_input_tokens',
    'cached_input_tokens',
    'cacheReadTokens',
    'cachedInputTokens',
    'cachedReadTokens',
  );
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (cache !== undefined) out.cacheReadTokens = cache;
  const cost = num(extra.costUsd);
  if (cost !== undefined) out.costUsd = cost;
  const dur = num(extra.durationMs);
  if (dur !== undefined) out.durationMs = dur;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Grok ACP 的 session/prompt 结果：_meta.usage 是整轮累计（含 modelCalls），
 * _meta.inputTokens / outputTokens 恰为最后一次请求（1.0.67 实测，input 已含缓存）→ 当前上下文。
 */
export function acpMetaContext(meta: unknown): { contextTokens?: number } {
  const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
  const input = num(m.inputTokens);
  const output = num(m.outputTokens);
  return input !== undefined ? { contextTokens: input + (output ?? 0) } : {};
}

/** 只在有值时附加可选字段，保持事件对象干净 */
export function withOpt<T extends object>(ev: T, extra: Record<string, unknown>): T {
  for (const [k, x] of Object.entries(extra))
    if (x !== undefined) (ev as Record<string, unknown>)[k] = x;
  return ev;
}

export const AGENT_END_STATUS: Record<string, 'completed' | 'failed' | 'stopped'> = {
  completed: 'completed',
  failed: 'failed',
  error: 'failed',
  errored: 'failed',
  stopped: 'stopped',
  killed: 'stopped',
  cancelled: 'stopped',
  shutdown: 'stopped',
  closed: 'stopped',
};

export function agentUsage(
  u: unknown,
): { toolUses?: number; tokens?: number; durationMs?: number } | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const o = u as Record<string, unknown>;
  const out = {
    ...(typeof o.tool_uses === 'number' ? { toolUses: o.tool_uses } : {}),
    ...(typeof o.total_tokens === 'number' ? { tokens: o.total_tokens } : {}),
    ...(typeof o.duration_ms === 'number' ? { durationMs: o.duration_ms } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

export const optStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
