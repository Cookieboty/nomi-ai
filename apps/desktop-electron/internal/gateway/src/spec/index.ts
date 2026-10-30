/**
 * 规范表入口（§6.2）：按协议取规范、把 SSE 文本解析成规范事件、整条流校验。
 */
import { SseParser } from '../stream/sse';

import { chatSpec } from './chat';
import { geminiSpec } from './gemini';
import { messagesSpec } from './messages';
import { responsesSpec } from './responses';
import { isObj, type SpecEvent, type Violation, type WireSpec } from './types';

export type SpecWire = WireSpec['wire'];

const SPECS: Record<SpecWire, WireSpec> = {
  responses: responsesSpec,
  chat: chatSpec,
  messages: messagesSpec,
  gemini: geminiSpec,
};

export function specOf(wire: SpecWire): WireSpec {
  return SPECS[wire];
}

/** 一个 SSE 事件（SseParser 的输出）→ 规范事件；data 不是 JSON 对象时为 null，Chat 的 [DONE] 记 done */
export function toSpecEvent(ev: { event?: string; data: string }): SpecEvent {
  const base = ev.event ? { event: ev.event } : {};
  if (ev.data.trim() === '[DONE]') return { ...base, data: null, done: true };
  let data: SpecEvent['data'];
  try {
    const v: unknown = JSON.parse(ev.data);
    data = isObj(v) ? v : null;
  } catch {
    data = null;
  }
  return { ...base, data };
}

/** SSE 全文 → 规范事件列表（注释行与空块忽略） */
export function parseSpecEvents(text: string): SpecEvent[] {
  const p = new SseParser();
  return [...p.push(text), ...p.end()].map(toSpecEvent);
}

/** 校验一整段 SSE 文本是否满足该协议的规范表 */
export function validateSse(wire: SpecWire, text: string): Violation[] {
  return SPECS[wire].validate(parseSpecEvents(text));
}

export { RESPONSES_EVENTS, RESPONSES_TERMINAL } from './responses';
export { MESSAGES_EVENTS } from './messages';
export { CHAT_FINISH_REASONS } from './chat';
export { GEMINI_FAILED_FINISH } from './gemini';
export type { SpecEvent, Violation, WireSpec } from './types';
