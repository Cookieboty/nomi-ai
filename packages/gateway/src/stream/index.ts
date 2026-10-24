/**
 * 流式协议转换入口：上游 SSE 文本分片 → 下游 SSE 文本。
 */
import { eventsToJson, type AggregateResult } from './aggregate';
import { createDecoder } from './decoders';
import {
  ChatCompletionsEncoder,
  GeminiEncoder,
  MessagesEncoder,
  ResponsesEncoder,
} from './encoders';
import type { NormEvent, StreamDecoder, StreamEncoder } from './events';
import { EventFixer, fixEvents, fixesEnabled, type ResponseFixOptions } from './fixer';
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
  /** 响应修正决定提前结束（复读检测）：调用方停止读上游 */
  readonly stopped: boolean;
}

export interface ConvertOptions {
  model?: string;
  customTools?: ReadonlySet<string>;
  /** 响应方向的上游毛病修正（§11.3）；不传时不做 */
  fixes?: ResponseFixOptions;
}

/** 工具调用 id 的种子与修正共用一个（§6.9.7）：没给修正时只按序号 */
const makeDecoder = (f: UpstreamStreamFormat, opts: ConvertOptions): StreamDecoder =>
  createDecoder(f, { seed: opts.fixes?.callIds?.seed });

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
  opts: ConvertOptions = {},
): StreamConverter {
  const parser = new SseParser();
  const dec = makeDecoder(from, opts);
  const enc = makeEncoder(to, opts.model ?? '', opts.customTools);
  const fixer = opts.fixes && fixesEnabled(opts.fixes) ? new EventFixer(opts.fixes) : null;
  const emit = (n: NormEvent): string => {
    if (!fixer) return enc.encode(n);
    let s = '';
    for (const f of fixer.push(n)) s += enc.encode(f);
    return s;
  };
  return {
    push(chunk) {
      let s = '';
      for (const ev of parser.push(chunk)) {
        for (const n of dec.push(ev)) s += emit(n);
        if (fixer?.tripped) break;
      }
      return s;
    },
    end() {
      let s = '';
      for (const ev of parser.end()) for (const n of dec.push(ev)) s += emit(n);
      for (const n of dec.end()) s += emit(n);
      return s + enc.end();
    },
    fail(message) {
      return enc.encode({ type: 'error', message, errorType: 'api_error' }) + enc.end();
    },
    get stopped() {
      return fixer?.tripped === true;
    },
  };
}

/** 上游返回了普通 JSON（未按流式响应）→ 合成完整的目标 SSE */
export function jsonToSse(
  from: UpstreamStreamFormat,
  to: DownstreamStreamFormat,
  body: unknown,
  opts: ConvertOptions = {},
): string {
  const enc = makeEncoder(to, opts.model ?? '', opts.customTools);
  let s = '';
  for (const n of jsonEvents(from, body, opts)) s += enc.encode(n);
  return s + enc.end();
}

/** 上游非流式 JSON → 下游非流式 JSON（经中间事件，保留工具调用/停止原因/用量） */
export function jsonToJson(
  from: UpstreamStreamFormat,
  to: DownstreamStreamFormat,
  body: unknown,
  opts: ConvertOptions = {},
): AggregateResult {
  return eventsToJson(to, jsonEvents(from, body, opts), opts);
}

function jsonEvents(from: UpstreamStreamFormat, body: unknown, opts: ConvertOptions): NormEvent[] {
  const evs = jsonToEvents(from, body, opts.fixes?.callIds?.seed);
  // 非流式不做复读检测（整段已经生成完）
  return opts.fixes && fixesEnabled(opts.fixes)
    ? fixEvents(evs, { ...opts.fixes, repetition: false })
    : evs;
}

export type { AggregateResult } from './aggregate';
export { jsonToEvents } from './json';
export { SseParser, formatSse } from './sse';
export type { NormEvent, StopReason, StreamUsage } from './events';
export { mergeUsage } from './events';
export { geminiErrorStatus } from './errors';
export type { ResponseFixOptions, ResponseFixSwitches } from './fixer';
