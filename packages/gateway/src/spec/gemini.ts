/**
 * Gemini streamGenerateContent（alt=sse）的规范表（§6.2）。结束标记：候选的 finishReason；
 * MALFORMED_FUNCTION_CALL 等表示生成失败的 finishReason 视为错误。只有 usageMetadata 的块合法。
 */
import { isObj, type Obj, type SpecEvent, type Violation, type WireSpec } from './types';

/** 表示生成失败（不是正常结束）的 finishReason */
export const GEMINI_FAILED_FINISH: ReadonlySet<string> = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
]);

function candidates(ev: SpecEvent): Obj[] {
  const c = ev.data?.candidates;
  return Array.isArray(c) ? c.filter(isObj) : [];
}

const finishOf = (ev: SpecEvent): string[] =>
  candidates(ev)
    .map((c) => c.finishReason)
    .filter(
      (r): r is string => typeof r === 'string' && r !== '' && r !== 'FINISH_REASON_UNSPECIFIED',
    );

function validate(events: readonly SpecEvent[]): Violation[] {
  const out: Violation[] = [];
  let terminal = -1;
  events.forEach((ev, i) => {
    const d = ev.data;
    if (!d) {
      out.push({ index: i, rule: 'invalid', detail: 'data is not a JSON object' });
      return;
    }
    if (isObj(d.error) || blocked(ev)) {
      if (terminal < 0) terminal = i;
      return;
    }
    if (!Array.isArray(d.candidates) && !isObj(d.usageMetadata) && !isObj(d.promptFeedback))
      out.push({ index: i, rule: 'missing-field', detail: 'chunk.candidates' });
    const usageOnly = !Array.isArray(d.candidates);
    if (terminal >= 0 && !usageOnly)
      out.push({ index: i, rule: 'after-terminal', detail: 'chunk' });
    for (const r of finishOf(ev))
      if (GEMINI_FAILED_FINISH.has(r))
        out.push({ index: i, rule: 'invalid', detail: `finishReason ${r}` });
    if (terminal < 0 && finishOf(ev).length) terminal = i;
  });
  if (terminal < 0)
    out.push({ index: -1, rule: 'no-terminal', detail: 'stream has no terminal event' });
  return out;
}

/** 提示词被拦截（没有候选，只有 promptFeedback.blockReason）：按失败结束 */
const blocked = (ev: SpecEvent) =>
  isObj(ev.data?.promptFeedback) && Boolean(ev.data.promptFeedback.blockReason);

export const geminiSpec: WireSpec = {
  wire: 'gemini',
  validate,
  isTerminal: (ev) => isObj(ev.data?.error) || blocked(ev) || finishOf(ev).length > 0,
  isContent: (ev) =>
    candidates(ev).some((c) => {
      const parts = isObj(c.content) && Array.isArray(c.content.parts) ? c.content.parts : [];
      return parts.some(
        (p) => isObj(p) && ((typeof p.text === 'string' && p.text !== '') || isObj(p.functionCall)),
      );
    }),
  isError: (ev) =>
    isObj(ev.data?.error) || blocked(ev) || finishOf(ev).some((r) => GEMINI_FAILED_FINISH.has(r)),
};
