/**
 * 流式协议转换入口：上游 SSE 文本分片 → 下游 SSE 文本。
 */
import { eventsToJson, type AggregateResult } from './aggregate';
import {
  ChatCompletionsDecoder,
  GeminiDecoder,
  MessagesDecoder,
  ResponsesDecoder,
} from './decoders';
import {
  ChatCompletionsEncoder,
  GeminiEncoder,
  MessagesEncoder,
  ResponsesEncoder,
} from './encoders';
import type { StreamDecoder, StreamEncoder } from './events';
import { jsonToEvents } from './json';
import { SseParser } from './sse';

/** 上游协议（解码方向） */
export type UpstreamStreamFormat = 'chat' | 'responses' | 'gemini' | 'messages';
/** 入口协议（编码方向）：四种都支持 */
export type DownstreamStreamFormat = 'messages' | 'responses' | 'chat' | 'gemini';

export interface StreamConverter {
  push(chunk: string): string;
  /** 上游正常结束 */
  end(): string;
  /** 上游中途失败（网络中断等）→ 下游错误事件 */
  fail(message: string): string;
}

function makeDecoder(f: UpstreamStreamFormat): StreamDecoder {
  switch (f) {
    case 'chat':
      return new ChatCompletionsDecoder();
    case 'responses':
      return new ResponsesDecoder();
    case 'gemini':
      return new GeminiDecoder();
    case 'messages':
      return new MessagesDecoder();
  }
}

function makeEncoder(
  f: DownstreamStreamFormat,
  model: string,
  customTools?: ReadonlySet<string>,
): StreamEncoder {
  switch (f) {
    case 'messages':
      return new MessagesEncoder(model);
    case 'responses':
      return new ResponsesEncoder(model, customTools);
    case 'chat':
      return new ChatCompletionsEncoder(model);
    case 'gemini':
      return new GeminiEncoder(model);
  }
}

export function createStreamConverter(
  from: UpstreamStreamFormat,
  to: DownstreamStreamFormat,
  opts: { model?: string; customTools?: ReadonlySet<string> } = {},
): StreamConverter {
  const parser = new SseParser();
  const dec = makeDecoder(from);
  const enc = makeEncoder(to, opts.model ?? '', opts.customTools);
  return {
    push(chunk) {
      let s = '';
      for (const ev of parser.push(chunk)) for (const n of dec.push(ev)) s += enc.encode(n);
      return s;
    },
    end() {
      let s = '';
      for (const ev of parser.end()) for (const n of dec.push(ev)) s += enc.encode(n);
      for (const n of dec.end()) s += enc.encode(n);
      return s + enc.end();
    },
    fail(message) {
      return enc.encode({ type: 'error', message, errorType: 'api_error' }) + enc.end();
    },
  };
}

/** 上游返回了普通 JSON（未按流式响应）→ 合成完整的目标 SSE */
export function jsonToSse(
  from: UpstreamStreamFormat,
  to: DownstreamStreamFormat,
  body: unknown,
  opts: { model?: string; customTools?: ReadonlySet<string> } = {},
): string {
  const enc = makeEncoder(to, opts.model ?? '', opts.customTools);
  let s = '';
  for (const n of jsonToEvents(from, body)) s += enc.encode(n);
  return s + enc.end();
}

/** 上游非流式 JSON → 下游非流式 JSON（经中间事件，保留工具调用/停止原因/用量） */
export function jsonToJson(
  from: UpstreamStreamFormat,
  to: DownstreamStreamFormat,
  body: unknown,
  opts: { model?: string; customTools?: ReadonlySet<string> } = {},
): AggregateResult {
  return eventsToJson(to, jsonToEvents(from, body), opts);
}

export type { AggregateResult } from './aggregate';
export { jsonToEvents } from './json';
export { SseParser, formatSse } from './sse';
export type { NormEvent, StopReason, StreamUsage } from './events';
export { mergeUsage } from './events';
export { geminiErrorStatus } from './errors';
