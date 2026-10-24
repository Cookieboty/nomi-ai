/**
 * OpenAI Responses 流的规范表（§6.2）。事件全集与 Grok 1.0.67 反序列化接受的列表逐项一致
 * （e2e-cli/snapshots/grok-1.0.67.json 对照测试）；必填字段按严格客户端逐项实测。
 */
import { isObj, missing, type Obj, type SpecEvent, type Violation, type WireSpec } from './types';

/**
 * 官方 Responses 流的全部事件类型。中转站自己加的事件（实测 amux 的 response.metadata）不在其中：
 * 严格客户端遇到未知类型直接报错丢掉整轮，宽松客户端（Codex）本来也会忽略，所以一律丢弃。
 */
export const RESPONSES_EVENTS: ReadonlySet<string> = new Set([
  'response.created',
  'response.in_progress',
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.queued',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.output_text.annotation.added',
  'response.refusal.delta',
  'response.refusal.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.custom_tool_call_input.delta',
  'response.custom_tool_call_input.done',
  'response.file_search_call.in_progress',
  'response.file_search_call.searching',
  'response.file_search_call.completed',
  'response.web_search_call.in_progress',
  'response.web_search_call.searching',
  'response.web_search_call.completed',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.image_generation_call.completed',
  'response.image_generation_call.generating',
  'response.image_generation_call.in_progress',
  'response.image_generation_call.partial_image',
  'response.mcp_call_arguments.delta',
  'response.mcp_call_arguments.done',
  'response.mcp_call.completed',
  'response.mcp_call.failed',
  'response.mcp_call.in_progress',
  'response.mcp_list_tools.completed',
  'response.mcp_list_tools.failed',
  'response.mcp_list_tools.in_progress',
  'response.code_interpreter_call.in_progress',
  'response.code_interpreter_call.interpreting',
  'response.code_interpreter_call.completed',
  'response.code_interpreter_call_code.delta',
  'response.code_interpreter_call_code.done',
  'error',
]);

/** 结束标记 */
export const RESPONSES_TERMINAL: ReadonlySet<string> = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
  'error',
]);

/** 带 response 对象的事件 */
export const RESPONSE_OBJECT_EVENTS =
  /^response\.(created|in_progress|completed|failed|incomplete|queued)$/;
/** 带 content_index 的增量 / 完成事件 */
export const RESPONSES_CONTENT_INDEX_EVENT = /^response\.(output_text|refusal|content_part)\./;
/** 指向某个条目（item_id + output_index）的事件 */
export const RESPONSES_ITEM_EVENT =
  /^response\.(output_text|refusal|content_part|function_call_arguments|reasoning_summary_text|reasoning_summary_part|reasoning_text|custom_tool_call_input)\./;
/** 内容增量（提交点 §6.11.2） */
const CONTENT_DELTA =
  /^response\.(output_text|refusal|function_call_arguments|custom_tool_call_input|reasoning_summary_text|reasoning_text)\.delta$/;

/** 对象必填字段 */
export const RESPONSES_OBJECT_REQUIRED = {
  response: ['id', 'object', 'status', 'created_at', 'model', 'output'],
  message: ['id', 'role', 'status', 'content'],
  reasoning: ['summary'],
  function_call: ['call_id', 'name', 'arguments'],
  output_text: ['annotations'],
} as const;

function itemViolations(item: Obj, i: number, where: string, out: Violation[]) {
  const t = item.type;
  const req =
    t === 'message'
      ? RESPONSES_OBJECT_REQUIRED.message
      : t === 'reasoning'
        ? RESPONSES_OBJECT_REQUIRED.reasoning
        : t === 'function_call'
          ? RESPONSES_OBJECT_REQUIRED.function_call
          : [];
  for (const f of missing(item, req))
    out.push({ index: i, rule: 'missing-field', detail: `${where}.${String(t)}.${f}` });
  if (t === 'message' && Array.isArray(item.content))
    for (const p of item.content)
      if (isObj(p) && p.type === 'output_text')
        for (const f of missing(p, RESPONSES_OBJECT_REQUIRED.output_text))
          out.push({ index: i, rule: 'missing-field', detail: `${where}.output_text.${f}` });
}

function validate(events: readonly SpecEvent[]): Violation[] {
  const out: Violation[] = [];
  const added = new Set<string>();
  const doneItems = new Set<string>();
  let terminal = -1;
  let first = true;
  events.forEach((ev, i) => {
    const d = ev.data;
    if (!d) {
      out.push({ index: i, rule: 'invalid', detail: 'data is not a JSON object' });
      return;
    }
    const type = typeof d.type === 'string' ? d.type : '';
    if (!RESPONSES_EVENTS.has(type)) {
      out.push({ index: i, rule: 'unknown-event', detail: type || '(no type)' });
      return;
    }
    if (terminal >= 0) out.push({ index: i, rule: 'after-terminal', detail: type });
    if (first && type !== 'response.created' && type !== 'response.queued' && type !== 'error')
      out.push({ index: i, rule: 'order', detail: `first event is ${type}` });
    first = false;
    if (typeof d.sequence_number !== 'number')
      out.push({ index: i, rule: 'missing-field', detail: `${type}.sequence_number` });
    if (RESPONSE_OBJECT_EVENTS.test(type)) {
      if (!isObj(d.response))
        out.push({ index: i, rule: 'missing-field', detail: `${type}.response` });
      else {
        for (const f of missing(d.response, RESPONSES_OBJECT_REQUIRED.response))
          out.push({ index: i, rule: 'missing-field', detail: `${type}.response.${f}` });
        if (Array.isArray(d.response.output))
          for (const it of d.response.output)
            if (isObj(it)) itemViolations(it, i, `${type}.response.output`, out);
      }
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      for (const f of missing(d, ['output_index', 'item']))
        out.push({ index: i, rule: 'missing-field', detail: `${type}.${f}` });
      if (isObj(d.item)) {
        if (type === 'response.output_item.done' || d.item.type !== 'message')
          itemViolations(d.item, i, type, out);
        const id = typeof d.item.id === 'string' ? d.item.id : '';
        if (id && type === 'response.output_item.added') added.add(id);
        if (id && type === 'response.output_item.done') {
          if (!added.has(id))
            out.push({ index: i, rule: 'order', detail: `item ${id} done before added` });
          doneItems.add(id);
        }
      }
    } else if (RESPONSES_ITEM_EVENT.test(type)) {
      const req = RESPONSES_CONTENT_INDEX_EVENT.test(type)
        ? ['item_id', 'output_index', 'content_index']
        : ['item_id', 'output_index'];
      for (const f of missing(d, req))
        out.push({ index: i, rule: 'missing-field', detail: `${type}.${f}` });
      const id = typeof d.item_id === 'string' ? d.item_id : '';
      if (id && !added.has(id))
        out.push({ index: i, rule: 'order', detail: `${type} for ${id} before item added` });
      if (id && doneItems.has(id))
        out.push({ index: i, rule: 'order', detail: `${type} for ${id} after item done` });
    }
    if (RESPONSES_TERMINAL.has(type) && terminal < 0) terminal = i;
  });
  if (terminal < 0)
    out.push({ index: -1, rule: 'no-terminal', detail: 'stream has no terminal event' });
  return out;
}

const typeOf = (ev: SpecEvent) => (ev.data && typeof ev.data.type === 'string' ? ev.data.type : '');

export const responsesSpec: WireSpec = {
  wire: 'responses',
  validate,
  isTerminal: (ev) => RESPONSES_TERMINAL.has(typeOf(ev)),
  isContent: (ev) => {
    const t = typeOf(ev);
    return CONTENT_DELTA.test(t) || t === 'response.output_item.done';
  },
  isError: (ev) => {
    const t = typeOf(ev);
    return t === 'error' || t === 'response.failed';
  },
};
