/**
 * OpenAI Chat Completions 流的规范表（§6.2）。结束标记：choice 的 finish_reason，或 `data: [DONE]`。
 * 典型非规范输入（由规范化 / 解码层兼容）：tool_calls 不带 index、arguments 是对象、content 是数组、
 * finish_reason 为空字符串。
 */
import { isObj, type SpecEvent, type Violation, type WireSpec } from './types';

export const CHAT_FINISH_REASONS: ReadonlySet<string> = new Set([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'function_call',
]);

function choicesOf(ev: SpecEvent): Record<string, unknown>[] {
  const c = ev.data?.choices;
  return Array.isArray(c) ? c.filter(isObj) : [];
}

function hasFinish(ev: SpecEvent): boolean {
  return choicesOf(ev).some((c) => typeof c.finish_reason === 'string' && c.finish_reason !== '');
}

function validate(events: readonly SpecEvent[]): Violation[] {
  const out: Violation[] = [];
  let terminal = -1;
  events.forEach((ev, i) => {
    if (ev.done) {
      if (terminal < 0) terminal = i;
      return;
    }
    const d = ev.data;
    if (!d) {
      out.push({ index: i, rule: 'invalid', detail: 'data is not a JSON object' });
      return;
    }
    if (isObj(d.error)) {
      if (terminal < 0) terminal = i;
      return;
    }
    // 只有 usage 的最后一块可以出现在 finish_reason 之后（stream_options.include_usage）
    const usageOnly = Array.isArray(d.choices) && d.choices.length === 0;
    if (terminal >= 0 && !usageOnly)
      out.push({ index: i, rule: 'after-terminal', detail: 'chunk' });
    if (!Array.isArray(d.choices))
      out.push({ index: i, rule: 'missing-field', detail: 'chunk.choices' });
    for (const c of choicesOf(ev)) {
      const fr = c.finish_reason;
      if (
        fr !== undefined &&
        fr !== null &&
        !(typeof fr === 'string' && CHAT_FINISH_REASONS.has(fr))
      )
        out.push({ index: i, rule: 'invalid', detail: `finish_reason ${JSON.stringify(fr)}` });
      const delta = isObj(c.delta) ? c.delta : {};
      if (
        delta.content !== undefined &&
        delta.content !== null &&
        typeof delta.content !== 'string'
      )
        out.push({ index: i, rule: 'invalid', detail: 'delta.content is not a string' });
      if (Array.isArray(delta.tool_calls))
        for (const tc of delta.tool_calls) {
          if (!isObj(tc)) continue;
          if (typeof tc.index !== 'number')
            out.push({ index: i, rule: 'missing-field', detail: 'delta.tool_calls.index' });
          const fn = isObj(tc.function) ? tc.function : {};
          if (fn.arguments !== undefined && typeof fn.arguments !== 'string')
            out.push({ index: i, rule: 'invalid', detail: 'tool_calls.function.arguments' });
        }
    }
    if (terminal < 0 && hasFinish(ev)) terminal = i;
  });
  if (terminal < 0)
    out.push({ index: -1, rule: 'no-terminal', detail: 'stream has no terminal event' });
  return out;
}

export const chatSpec: WireSpec = {
  wire: 'chat',
  validate,
  isTerminal: (ev) => ev.done === true || isObj(ev.data?.error) || hasFinish(ev),
  isContent: (ev) =>
    choicesOf(ev).some((c) => {
      const d = isObj(c.delta) ? c.delta : {};
      return (
        (typeof d.content === 'string' && d.content !== '') ||
        (Array.isArray(d.content) && d.content.length > 0) ||
        (typeof d.reasoning_content === 'string' && d.reasoning_content !== '') ||
        (typeof d.reasoning === 'string' && d.reasoning !== '') ||
        (Array.isArray(d.tool_calls) && d.tool_calls.length > 0)
      );
    }),
  isError: (ev) => isObj(ev.data?.error),
};
