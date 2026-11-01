/**
 * 端点规则表：供应商（预设 / 地址）× 上游模型名 → 用哪个适配器、取供应商的哪个协议地址。
 * 纯数据 + 一个按序匹配的解析函数；规则有先后，带供应商限定的在前，最后一条是 OpenAI Images 兜底。
 */
import type { Wire } from '../ir';

import { IMAGE_ADAPTERS } from './adapters';
import type { ImageAuth, ImageEndpoint, ImageProviderInfo } from './types';
import { trimSlash } from './util';

export interface ImageEndpointRule {
  /** 适配器 id（adapters/index.ts） */
  adapter: string;
  /** 上游模型名（去掉 models/ 前缀前后都试） */
  model?: RegExp;
  /** 只对这些预设或地址匹配的供应商生效；都不写 = 任何供应商 */
  presets?: string[];
  host?: RegExp;
  /** 用供应商哪个协议的地址与 Key（默认 chat）；供应商没有这个地址时规则不生效 */
  wire?: Wire;
  /** 地址推导：origin = 只取站点根（如 DashScope 的 compatible-mode/v1 → 站点）；默认原样 */
  base?: 'origin';
}

export const IMAGE_ENDPOINT_RULES: readonly ImageEndpointRule[] = [
  // 官方 / 专用接口（按供应商限定）
  { adapter: 'openrouter-chat-image', host: /(^|\.)openrouter\.ai$/i, presets: ['openrouter'] },
  {
    adapter: 'gemini',
    model: /^gemini.*image/i,
    wire: 'gemini',
    host: /generativelanguage\.googleapis\.com$/i,
    presets: ['gemini'],
  },
  {
    adapter: 'imagen',
    model: /^imagen/i,
    wire: 'gemini',
    host: /generativelanguage\.googleapis\.com$/i,
    presets: ['gemini'],
  },
  {
    adapter: 'ark-image',
    model: /seedream|seededit/i,
    host: /volces\.com$/i,
    presets: ['doubao', 'volcengine'],
  },
  { adapter: 'fal', host: /(^|\.)fal\.(run|ai)$/i, presets: ['fal'] },
  {
    adapter: 'dashscope-async',
    model: /^(wanx|wan\d|qwen-image)/i,
    host: /(^|\.)dashscope(-intl)?\.aliyuncs\.com$/i,
    presets: ['dashscope', 'qwen', 'bailian'],
    base: 'origin',
  },
  // 中转站：开了 Gemini 协议的，Gemini 生图模型走原生接口（鉴权按探测到的方式）
  { adapter: 'gemini', model: /^gemini.*image/i, wire: 'gemini' },
  { adapter: 'imagen', model: /^imagen/i, wire: 'gemini' },
  // 兜底：OpenAI 兼容的 /images/generations（OpenAI 官方与大多数中转）
  { adapter: 'openai-images' },
];

const hostOf = (url: string | undefined): string => {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
};

function providerMatches(r: ImageEndpointRule, p: ImageProviderInfo): boolean {
  if (!r.presets && !r.host) return true;
  if (p.presetId && r.presets?.includes(p.presetId)) return true;
  return !!r.host && Object.values(p.urls).some((u) => r.host!.test(hostOf(u)));
}

const baseOf = (url: string, how: ImageEndpointRule['base']): string => {
  if (how === 'origin') {
    try {
      return new URL(url).origin;
    } catch {
      return trimSlash(url);
    }
  }
  return trimSlash(url);
};

/** 适配器默认的 Key 放法 vs 供应商这个协议探测到的：Bearer 型适配器跟随探测；Gemini 型在中转站常是 Bearer */
function authFor(
  adapterAuth: ImageAuth,
  detected: ImageProviderInfo['auth'],
  wire: Wire,
): ImageAuth {
  if (adapterAuth === 'key') return 'key';
  return detected?.[wire] ?? adapterAuth;
}

export function resolveImageEndpoint(
  provider: ImageProviderInfo,
  upstreamModel: string,
  rules: readonly ImageEndpointRule[] = IMAGE_ENDPOINT_RULES,
): ImageEndpoint | null {
  const bare = upstreamModel.replace(/^models\//, '');
  const last = bare.slice(bare.lastIndexOf('/') + 1);
  for (const r of rules) {
    if (r.model && !r.model.test(bare) && !r.model.test(last)) continue;
    if (!providerMatches(r, provider)) continue;
    const wire = r.wire ?? 'chat';
    const url = provider.urls[wire];
    const adapter = IMAGE_ADAPTERS[r.adapter];
    if (!url || !adapter) continue;
    return {
      adapter,
      baseURL: baseOf(url, r.base),
      wire,
      auth: authFor(adapter.auth, provider.auth, wire),
    };
  }
  return null;
}

/** 按适配器的 Key 放法生成鉴权头 */
export function imageAuthHeaders(
  auth: ImageAuth,
  apiKey: string | undefined,
): Record<string, string> {
  if (!apiKey) return {};
  switch (auth) {
    case 'key':
      return { Authorization: `Key ${apiKey}` };
    case 'x-goog-api-key':
      return { 'x-goog-api-key': apiKey };
    case 'x-api-key':
      return { 'x-api-key': apiKey };
    default:
      return { Authorization: `Bearer ${apiKey}` };
  }
}
