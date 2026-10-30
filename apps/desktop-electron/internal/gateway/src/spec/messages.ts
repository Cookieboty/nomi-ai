/**
 * Anthropic Messages 流的规范表（§6.2）。结束标记：message_stop（或带 stop_reason 的 message_delta）、error。
 * 顺序：message_start 在最前；content_block 索引从 0 连续；start 先于 delta，stop 之后不再有 delta。
 */
import { isObj, missing, type SpecEvent, type Violation, type WireSpec } from './types';

export const MESSAGES_EVENTS: ReadonlySet<string> = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'ping',
  'error',
]);

const typeOf = (ev: SpecEvent) =>
  ev.data && typeof ev.data.type === 'string' ? ev.data.type : (ev.event ?? '');

function validate(events: readonly SpecEvent[]): Violation[] {
  const out: Violation[] = [];
  const open = new Set<number>();
  const closed = new Set<number>();
  let next = 0;
  let terminal = -1;
  let first = true;
  events.forEach((ev, i) => {
    const d = ev.data;
    const type = typeOf(ev);
    if (!d) {
      out.push({ index: i, rule: 'invalid', detail: 'data is not a JSON object' });
      return;
    }
    if (!MESSAGES_EVENTS.has(type)) {
      out.push({ index: i, rule: 'unknown-event', detail: type || '(no type)' });
      return;
    }
    if (type === 'ping') return;
    if (terminal >= 0 && type !== 'message_stop')
      out.push({ index: i, rule: 'after-terminal', detail: type });
    if (first && type !== 'message_start' && type !== 'error')
      out.push({ index: i, rule: 'order', detail: `first event is ${type}` });
    first = false;
    if (type === 'message_start') {
      if (!isObj(d.message))
        out.push({ index: i, rule: 'missing-field', detail: 'message_start.message' });
      else
        for (const f of missing(d.message, ['id', 'type', 'role', 'content', 'model', 'usage']))
          out.push({ index: i, rule: 'missing-field', detail: `message_start.message.${f}` });
    }
    if (type.startsWith('content_block_')) {
      const idx = typeof d.index === 'number' ? d.index : -1;
      if (idx < 0) out.push({ index: i, rule: 'missing-field', detail: `${type}.index` });
      else if (type === 'content_block_start') {
        if (idx !== next)
          out.push({ index: i, rule: 'order', detail: `block index ${idx}, expected ${next}` });
        next = Math.max(next, idx + 1);
        open.add(idx);
        if (!isObj(d.content_block))
          out.push({
            index: i,
            rule: 'missing-field',
            detail: 'content_block_start.content_block',
          });
      } else {
        if (!open.has(idx) || closed.has(idx))
          out.push({ index: i, rule: 'order', detail: `${type} for block ${idx} not open` });
        if (type === 'content_block_stop') closed.add(idx);
        if (type === 'content_block_delta' && !isObj(d.delta))
          out.push({ index: i, rule: 'missing-field', detail: 'content_block_delta.delta' });
      }
    }
    if (type === 'message_stop' || type === 'error') {
      if (terminal < 0) terminal = i;
    }
  });
  if (terminal < 0)
    out.push({ index: -1, rule: 'no-terminal', detail: 'stream has no terminal event' });
  return out;
}

export const messagesSpec: WireSpec = {
  wire: 'messages',
  validate,
  isTerminal: (ev) => {
    const t = typeOf(ev);
    if (t === 'message_stop' || t === 'error') return true;
    const delta = ev.data && isObj(ev.data.delta) ? ev.data.delta : null;
    return t === 'message_delta' && typeof delta?.stop_reason === 'string';
  },
  isContent: (ev) => {
    const t = typeOf(ev);
    return t === 'content_block_delta' || (t === 'content_block_start' && isToolBlock(ev));
  },
  isError: (ev) => typeOf(ev) === 'error',
};

function isToolBlock(ev: SpecEvent): boolean {
  const b = ev.data && isObj(ev.data.content_block) ? ev.data.content_block : null;
  return b?.type === 'tool_use' || b?.type === 'server_tool_use';
}
