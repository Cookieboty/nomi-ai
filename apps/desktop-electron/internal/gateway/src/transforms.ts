/**
 * 两两协议转换的旧接口（本地路由服务在用）。
 * 请求方向统一走 IR：入口解码 → 上游编码（见 ./request）；同协议时调用方直接透传，不经过这里。
 * 非流式响应方向的跨协议转换走 ./stream 的 jsonToJson（经中间事件，保留工具调用与用量）；
 * 下面的 xxxResponseToYyy 只取正文，保留给旧调用方。
 */
import {
  decodeChat,
  decodeMessages,
  decodeResponses,
  encodeChat,
  encodeGemini,
  encodeMessages,
  encodeResponses,
} from './request';
import { asObj, type Json } from './util';

export type { Json } from './util';

export function messagesToChatCompletions(body: unknown, model?: string): Json {
  return encodeChat(decodeMessages(body), model);
}

export function messagesToResponses(body: unknown, model?: string): Json {
  return encodeResponses(decodeMessages(body), model);
}

/** 不含 model：Gemini 的模型放在 URL 路径里 */
export function messagesToGemini(body: unknown, _model?: string): Json {
  return encodeGemini(decodeMessages(body));
}

export function responsesToMessages(body: unknown, model?: string): Json {
  return encodeMessages(decodeResponses(body), model);
}

/** OpenAI Responses → Chat Completions */
export function responsesToChatCompletions(body: unknown, model?: string): Json {
  return encodeChat(decodeResponses(body), model);
}

export function chatCompletionsToMessages(body: unknown, model?: string): Json {
  return encodeMessages(decodeChat(body), model);
}

/** Chat Completions → OpenAI Responses */
export function chatCompletionsToResponses(body: unknown, model?: string): Json {
  return encodeResponses(decodeChat(body), model);
}

/** 将上游 Chat Completions 非流式响应转成 Anthropic Messages 形状 */
export function chatCompletionsResponseToMessages(upstream: unknown): Json {
  const u = asObj(upstream);
  const choices = Array.isArray(u.choices) ? (u.choices as Array<Record<string, unknown>>) : [];
  const msg = asObj(choices[0]?.message);
  const text = typeof msg.content === 'string' ? msg.content : '';
  return {
    id: String(u.id ?? 'msg_nomi'),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: String(u.model ?? ''),
    stop_reason: 'end_turn',
  };
}

/** 将上游 Responses 非流式响应转成 Anthropic Messages */
export function responsesResponseToMessages(upstream: unknown): Json {
  const u = asObj(upstream);
  let text = '';
  const output = Array.isArray(u.output) ? (u.output as Array<Record<string, unknown>>) : [];
  for (const item of output) {
    const content = Array.isArray(item.content)
      ? (item.content as Array<Record<string, unknown>>)
      : [];
    for (const c of content) {
      if (c.type === 'output_text' || c.type === 'text') text += String(c.text ?? '');
    }
  }
  if (!text && typeof u.output_text === 'string') text = u.output_text;
  return {
    id: String(u.id ?? 'msg_nomi'),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: String(u.model ?? ''),
    stop_reason: 'end_turn',
  };
}

/** Anthropic Messages 响应 → Chat Completions */
export function messagesResponseToChatCompletions(upstream: unknown): Json {
  const u = asObj(upstream);
  let text = '';
  if (Array.isArray(u.content)) {
    text = (u.content as Array<Record<string, unknown>>)
      .filter((c) => c.type === 'text')
      .map((c) => String(c.text ?? ''))
      .join('');
  }
  return {
    id: String(u.id ?? 'chatcmpl_nomi'),
    object: 'chat.completion',
    model: String(u.model ?? ''),
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
}

/** Anthropic Messages 响应 → Responses */
export function messagesResponseToResponses(upstream: unknown): Json {
  const u = asObj(upstream);
  let text = '';
  if (Array.isArray(u.content)) {
    text = (u.content as Array<Record<string, unknown>>)
      .filter((c) => c.type === 'text')
      .map((c) => String(c.text ?? ''))
      .join('');
  }
  return {
    id: String(u.id ?? 'resp_nomi'),
    object: 'response',
    model: String(u.model ?? ''),
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    output_text: text,
  };
}

export function chatCompletionsResponseToResponses(upstream: unknown): Json {
  return messagesResponseToResponses(chatCompletionsResponseToMessages(upstream));
}

export function responsesResponseToChatCompletions(upstream: unknown): Json {
  return messagesResponseToChatCompletions(responsesResponseToMessages(upstream));
}

/** Gemini generateContent 响应 → Anthropic Messages */
export function geminiResponseToMessages(upstream: unknown): Json {
  const u = asObj(upstream);
  const candidates = Array.isArray(u.candidates)
    ? (u.candidates as Array<Record<string, unknown>>)
    : [];
  const content = asObj(candidates[0]?.content);
  const parts = Array.isArray(content.parts)
    ? (content.parts as Array<Record<string, unknown>>)
    : [];
  const text = parts.map((p) => String(p.text ?? '')).join('');
  return {
    id: 'msg_nomi_gemini',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: '',
    stop_reason: 'end_turn',
  };
}
