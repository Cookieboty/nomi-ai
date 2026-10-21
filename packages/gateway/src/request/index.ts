/**
 * 跨协议请求转换：入口请求 → IR → 上游请求。
 * 同协议时不要调用这里（§9.2：同协议只做外科式改写，不经过 IR）。
 */
import type { IRRequest, Wire } from '../ir';
import type { Json } from '../util';

import { decodeChat, decodeGemini, decodeMessages, decodeResponses } from './decode';
import { encodeChat, encodeGemini, encodeMessages, encodeResponses } from './encode';

export interface DecodeOptions {
  /** Gemini 入口：模型名与是否流式都在路径里 */
  model?: string;
  stream?: boolean;
}

export function decodeRequest(wire: Wire, body: unknown, opts: DecodeOptions = {}): IRRequest {
  switch (wire) {
    case 'messages':
      return decodeMessages(body);
    case 'responses':
      return decodeResponses(body);
    case 'chat':
      return decodeChat(body);
    case 'gemini':
      return decodeGemini(body, opts);
  }
}

/** @param model 上游的模型名；Gemini 的模型在路径里，请求体不带 */
export function encodeRequest(wire: Wire, ir: IRRequest, model?: string): Json {
  switch (wire) {
    case 'messages':
      return encodeMessages(ir, model);
    case 'responses':
      return encodeResponses(ir, model);
    case 'chat':
      return encodeChat(ir, model);
    case 'gemini':
      return encodeGemini(ir);
  }
}

export function convertRequest(
  from: Wire,
  to: Wire,
  body: unknown,
  opts: DecodeOptions & { upstreamModel?: string } = {},
): Json {
  return encodeRequest(to, decodeRequest(from, body, opts), opts.upstreamModel);
}

export { decodeChat, decodeGemini, decodeMessages, decodeResponses } from './decode';
export { encodeChat, encodeGemini, encodeMessages, encodeResponses } from './encode';
