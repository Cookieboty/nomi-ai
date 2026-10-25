/**
 * 上游协议：只有三种，全部经 Vercel AI SDK 通用实现，
 * 没有任何按厂商写死的代码路径——厂商差异只体现在 preset 的预填值上。
 *
 *   openai-chat       OpenAI Chat Completions   POST {base}/chat/completions   (@ai-sdk/openai-compatible)
 *   openai-responses  OpenAI Responses          POST {base}/responses          (@ai-sdk/openai .responses())
 *   anthropic         Anthropic Messages        POST {base}/v1/messages        (@ai-sdk/anthropic)
 *
 * 「完整 URL」开关：打开时 baseURL 就是最终请求地址，原样使用（不再拼路径）。
 */
export const PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export const PROTOCOL_LABELS: Readonly<Record<Protocol, string>> = {
  'openai-chat': 'ai-runtime.providers.protocol-openai-chat',
  'openai-responses': 'ai-runtime.providers.protocol-openai-responses',
  anthropic: 'ai-runtime.providers.protocol-anthropic',
};

export function isProtocol(v: unknown): v is Protocol {
  return typeof v === 'string' && (PROTOCOLS as readonly string[]).includes(v);
}

const PATH: Readonly<Record<Protocol, string>> = {
  'openai-chat': '/chat/completions',
  'openai-responses': '/responses',
  anthropic: '/messages',
};

export function trimBase(u: string): string {
  return u.trim().replace(/\/+$/, '');
}

/** Anthropic 的 base 习惯写成 `https://api.anthropic.com`（不带 /v1）；两种写法都接受。 */
function anthropicV1(base: string): string {
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

/**
 * 交给 AI SDK 的 baseURL（SDK 自己会拼上 PATH 部分）。
 * 完整 URL 模式下返回去掉 PATH 的前缀（拼回去恰好是原 URL）；不以 PATH 结尾时由 fetch 改写兜底。
 */
export function sdkBaseURL(protocol: Protocol, baseURL: string, fullUrl = false): string {
  const base = trimBase(baseURL);
  if (fullUrl) {
    const path = base.split('?')[0]!;
    const suffix = PATH[protocol];
    return path.toLowerCase().endsWith(suffix) ? path.slice(0, -suffix.length) : path;
  }
  return protocol === 'anthropic' ? anthropicV1(base) : base;
}

/** 实际请求的端点（UI 预览 + 测试断言用）。 */
export function endpointURL(protocol: Protocol, baseURL: string, fullUrl = false): string {
  const base = trimBase(baseURL);
  if (fullUrl) return base;
  return `${sdkBaseURL(protocol, base, false)}${PATH[protocol]}`;
}

/**
 * 完整 URL 模式：SDK 拼出来的地址不等于用户填写的地址时，把请求改写到用户地址（保留 query）。
 * 非完整 URL 模式返回 undefined（不包装）。
 */
export function fullUrlFetch(
  protocol: Protocol,
  baseURL: string,
  fullUrl: boolean,
  inner: typeof fetch = fetch,
): typeof fetch | undefined {
  if (!fullUrl) return undefined;
  const target = trimBase(baseURL);
  const sdkEndpoint = `${sdkBaseURL(protocol, target, true)}${PATH[protocol]}`;
  if (sdkEndpoint === target) return undefined;
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // SDK 拼出的端点（不论是否带 query）一律改写为用户填写的完整地址
    const next = url.split('?')[0] === sdkEndpoint ? target : url;
    return inner(next, init);
  }) as typeof fetch;
}

/** 模型列表地址：OpenAI 风格 `GET {base}/models`；Anthropic `GET {base}/v1/models`。 */
export function modelsURL(protocol: Protocol, baseURL: string, fullUrl = false): string {
  let base = trimBase(baseURL);
  if (fullUrl) {
    const suffix = PATH[protocol];
    if (base.toLowerCase().endsWith(suffix)) base = base.slice(0, -suffix.length);
    else {
      try {
        base = new URL(base).origin + (protocol === 'anthropic' ? '' : '/v1');
      } catch {
        /* keep */
      }
    }
  }
  return protocol === 'anthropic' ? `${anthropicV1(base)}/models` : `${base}/models`;
}

export function modelsRequestHeaders(
  protocol: Protocol,
  apiKey: string | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json', ...extra };
  if (protocol === 'anthropic') {
    if (apiKey) h['x-api-key'] = apiKey;
    h['anthropic-version'] = '2023-06-01';
  } else if (apiKey) {
    h.authorization = `Bearer ${apiKey}`;
  }
  return h;
}

export interface FetchedModel {
  id: string;
  name?: string;
  ownedBy?: string;
}

/**
 * 解析模型列表。兼容：
 *  - OpenAI `{ object: 'list', data: [{ id, owned_by }] }`
 *  - Anthropic `{ data: [{ id, display_name, type: 'model' }], has_more }`
 *  - Ollama 等 `{ models: [{ name | model }] }`、裸数组
 */
export function parseModelList(json: unknown): FetchedModel[] {
  const root = json as Record<string, unknown> | unknown[] | null;
  const arr: unknown[] = Array.isArray(root)
    ? root
    : Array.isArray((root as Record<string, unknown>)?.data)
      ? ((root as Record<string, unknown>).data as unknown[])
      : Array.isArray((root as Record<string, unknown>)?.models)
        ? ((root as Record<string, unknown>).models as unknown[])
        : [];
  const out: FetchedModel[] = [];
  const seen = new Set<string>();
  for (const it of arr) {
    const o = (typeof it === 'string' ? { id: it } : it) as Record<string, unknown>;
    const id = [o?.id, o?.model, o?.name].find((v) => typeof v === 'string' && v.trim()) as
      string | undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof o.display_name === 'string' ? o.display_name : undefined;
    const ownedBy = typeof o.owned_by === 'string' ? o.owned_by : undefined;
    out.push({ id, ...(name ? { name } : {}), ...(ownedBy ? { ownedBy } : {}) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface ModelMapping {
  /** 请求中的模型名（`*` 匹配任意） */
  from: string;
  /** 实际发给上游的模型名 */
  to: string;
}

/** 模型映射：精确匹配优先，其次 `*`。 */
export function mapModel(model: string, mapping: readonly ModelMapping[] | undefined): string {
  if (!mapping?.length) return model;
  const exact = mapping.find((m) => m.from === model && m.to.trim());
  if (exact) return exact.to.trim();
  const any = mapping.find((m) => m.from === '*' && m.to.trim());
  return any ? any.to.trim() : model;
}
