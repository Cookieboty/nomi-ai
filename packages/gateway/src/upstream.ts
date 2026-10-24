/**
 * 上游请求的拼装：地址（§8.1 的约定）、鉴权头（§8.3）、请求体（同协议外科式改写 / 跨协议经 IR）。
 */
import type { AuthStyle } from './config';
import { customToolsToFunctions } from './customTools';
import {
  applyRequestFixes,
  candidateModel,
  filterAnthropicBeta,
  isAnthropicOfficial,
} from './fixes';
import { geminiModelPath } from './ingress';
import { readIntent, renderIntent, withBindingEffort } from './intent';
import type { Wire } from './ir';
import { quirksOf } from './providers/index';
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
    let beta = opts.sameWire ? header('anthropic-beta') : undefined;
    // 第三方 Messages 上游不认识 context-1m-… 等 Anthropic 专有 beta（§12.7.3）
    if (beta && !isAnthropicOfficial(c)) beta = filterAnthropicBeta(beta);
    if (beta) h['anthropic-beta'] = beta;
  }
  const userAgent =
    c.provider.userAgent ??
    (opts.sameWire ? header('user-agent') : quirksOf(c.provider, c.wire).userAgent);
  if (userAgent) h['User-Agent'] = userAgent;
  return { ...h, ...(c.provider.headers ?? {}) };
}

/**
 * 发给上游的请求体。
 * 同协议：只做外科式改写（替换模型名），其余字段原样保留，避免丢掉协议的新字段（§9.2）；
 * 跨协议：入口解码成 IR，再编码成上游协议。
 * Chat 流式时补 stream_options.include_usage，否则拿不到用量。
 * 两条路径最后都过一遍 §12.7.3 的请求修正（输出上限、推理、图片、工具 schema 等），
 * 修正说明追加到 opts.notes。
 */
export function upstreamBody(
  ingress: Wire,
  c: Candidate,
  body: unknown,
  opts: {
    stream: boolean;
    ingressModel?: string;
    notes?: string[];
    client?: string;
    /** 标签上选的思考深度（TabBinding.effort）：请求里没有显式意图时用（§6.9.5） */
    bindingEffort?: string;
  },
): unknown {
  let out: unknown;
  if (ingress === c.wire) {
    out =
      c.wire === 'gemini' ? body : { ...(body as Record<string, unknown>), model: c.upstreamModel };
    // Responses 上游拒绝过 custom 工具：改成函数发出（§11.3），回程由 respond 还原
    if (c.customToolsAsFunctions && c.wire === 'responses') {
      const converted = customToolsToFunctions(out);
      if (converted !== out)
        opts.notes?.push('custom 工具已改成函数发出（上游不支持 custom 工具）');
      out = converted;
    }
  } else {
    out = convertRequest(ingress, c.wire, body, {
      model: opts.ingressModel,
      stream: opts.stream,
      upstreamModel: c.upstreamModel,
      reasoningPassback: quirksOf(c.provider, c.wire).reasoningPassback,
    });
    // 跨协议：编码器不写推理参数，按入口的推理意图渲染到上游请求体（§6.9.5）
    const intent = withBindingEffort(readIntent(ingress, body, opts.client), opts.bindingEffort);
    if (intent) out = renderIntent(c.wire, out, intent, candidateModel(c), opts.notes);
  }
  if (c.wire === 'chat' && opts.stream && out && typeof out === 'object') {
    out = { ...(out as object), stream: true, stream_options: { include_usage: true } };
  }
  out = applyRequestFixes(c, out, opts.notes);
  // 厂商不接受的可选字段（quirks.dropParams + 运行时学到的，§7.4）
  if (c.dropParams?.length && out && typeof out === 'object' && !Array.isArray(out)) {
    const o = { ...(out as Record<string, unknown>) };
    for (const k of c.dropParams) delete o[k];
    out = o;
  }
  return out;
}
