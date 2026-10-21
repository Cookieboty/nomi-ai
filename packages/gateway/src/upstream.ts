/**
 * 上游请求的拼装：地址（§8.1 的约定）、鉴权头（§8.3）、请求体（同协议外科式改写 / 跨协议经 IR）。
 */
import type { AuthStyle } from './config';
import { geminiModelPath } from './ingress';
import type { Wire } from './ir';
import { convertRequest } from './request';
import type { Candidate } from './route/resolve';

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

/** 上游完整地址。messages 的 base 不带 /v1（兼容带了的旧配置），其余 base 直接拼路径 */
export function upstreamUrl(
  wire: Wire,
  base: string,
  model: string,
  opts: { stream?: boolean; countTokens?: boolean } = {},
): string {
  const b = trimSlash(base);
  switch (wire) {
    case 'messages': {
      const v1 = /\/v1$/.test(b) ? b : `${b}/v1`;
      return `${v1}/messages${opts.countTokens ? '/count_tokens' : ''}`;
    }
    case 'responses':
      return `${b}/responses`;
    case 'chat':
      return `${b}/chat/completions`;
    case 'gemini':
      return `${b}/models/${geminiModelPath(model)}:${
        opts.countTokens
          ? 'countTokens'
          : opts.stream
            ? 'streamGenerateContent?alt=sse'
            : 'generateContent'
      }`;
  }
}

const DEFAULT_AUTH: Record<Wire, AuthStyle> = {
  messages: 'x-api-key',
  responses: 'bearer',
  chat: 'bearer',
  gemini: 'x-goog-api-key',
};

/**
 * 上游请求头：鉴权按协议默认（探测发现别的方式时用探测结果），再叠加供应商的自定义头。
 * 同协议时透传 CLI 自己的 User-Agent（部分 Coding Plan 按它识别编程助手）和 anthropic-beta；
 * 转换协议时用预设里的 User-Agent（§12.7.3）。
 */
export function upstreamHeaders(
  c: Candidate,
  opts: {
    stream: boolean;
    clientHeaders: Record<string, string | string[] | undefined>;
    sameWire: boolean;
  },
): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: opts.stream ? 'text/event-stream' : 'application/json',
  };
  const auth = c.provider.detected?.[c.wire]?.auth ?? DEFAULT_AUTH[c.wire];
  // 本地服务（Ollama / LM Studio / llama.cpp）没有 Key：不发鉴权头
  if (c.key.value) {
    if (auth === 'x-api-key') h['x-api-key'] = c.key.value;
    else if (auth === 'x-goog-api-key') h['x-goog-api-key'] = c.key.value;
    else h.Authorization = `Bearer ${c.key.value}`;
  }
  const header = (name: string) => {
    const v = opts.clientHeaders[name];
    return typeof v === 'string' && v ? v : undefined;
  };
  if (c.wire === 'messages') {
    h['anthropic-version'] = (opts.sameWire && header('anthropic-version')) || '2023-06-01';
    const beta = opts.sameWire ? header('anthropic-beta') : undefined;
    if (beta) h['anthropic-beta'] = beta;
  }
  const userAgent =
    c.provider.userAgent ?? (opts.sameWire ? header('user-agent') : c.provider.quirks?.userAgent);
  if (userAgent) h['User-Agent'] = userAgent;
  return { ...h, ...(c.provider.headers ?? {}) };
}

/**
 * 发给上游的请求体。
 * 同协议：只做外科式改写（替换模型名），其余字段原样保留，避免丢掉协议的新字段（§9.2）；
 * 跨协议：入口解码成 IR，再编码成上游协议。
 * Chat 流式时补 stream_options.include_usage，否则拿不到用量。
 */
export function upstreamBody(
  ingress: Wire,
  c: Candidate,
  body: unknown,
  opts: { stream: boolean; ingressModel?: string },
): unknown {
  let out: unknown;
  if (ingress === c.wire) {
    out =
      c.wire === 'gemini' ? body : { ...(body as Record<string, unknown>), model: c.upstreamModel };
  } else {
    out = convertRequest(ingress, c.wire, body, {
      model: opts.ingressModel,
      stream: opts.stream,
      upstreamModel: c.upstreamModel,
    });
  }
  if (c.wire === 'chat' && opts.stream && out && typeof out === 'object') {
    out = { ...(out as object), stream: true, stream_options: { include_usage: true } };
  }
  return out;
}
