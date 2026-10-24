/**
 * 解码前的规范化（§6.4「解码器只处理规范事件流」）：转换路径与各种旁路解码（结束检测、复读检测）
 * 拿到的上游事件先经过这里，解码器里不再保留兼容分支。
 * - Chat：字段归一（ChatChunkNormalizer：缺 index、对象形式的 arguments、数组形式的 content…）；
 * - Responses：保活与规范全集之外的事件丢掉；只在 output_item.done / response.completed 里给完整条目
 *   （不发增量）的中转站，按规范展开成增量：message → output_text.delta，function_call →
 *   output_item.added（带完整参数）+ output_item.done。上游按增量发过的不重复展开（增量与条目 id
 *   未必对得上，宁可不补也不重复）。
 * - Gemini / Messages：解码器直接按规范处理，这里不动。
 * 与输出方向的 ResponsesCanonicalizer 分开：那一个按 SSE 文本补必填字段、给客户端看；
 * 这一个按解析后的事件工作、只给解码器看，展开出的事件不会发给透传的客户端。
 */
import { RESPONSES_EVENTS } from '../spec/responses';
import type { SseEvent } from '../stream/sse';

import { ChatChunkNormalizer } from './chat';
import { isResponsesKeepAlive } from './responses';
import type { CanonicalWire } from './terminal';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function parse(data: string): Obj | null {
  try {
    const v: unknown = JSON.parse(data);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

export interface UpstreamCanonicalizer {
  push(ev: SseEvent): SseEvent[];
}

class ChatUpstream implements UpstreamCanonicalizer {
  private readonly norm = new ChatChunkNormalizer();

  push(ev: SseEvent): SseEvent[] {
    const j = ev.data.trim() === '[DONE]' ? null : parse(ev.data);
    if (!j || j.error) return [ev];
    return this.norm.normalize(j) ? [{ ...ev, data: JSON.stringify(j) }] : [ev];
  }
}

/** message 条目里的完整正文（output_text / refusal 部分） */
function itemText(item: Obj): string {
  const parts = Array.isArray(item.content) ? (item.content as unknown[]) : [];
  return parts
    .map((p) => {
      if (!isObj(p)) return '';
      if (p.type === 'output_text' && typeof p.text === 'string') return p.text;
      if (p.type === 'refusal' && typeof p.refusal === 'string') return p.refusal;
      return '';
    })
    .join('');
}

class ResponsesUpstream implements UpstreamCanonicalizer {
  /** 上游按增量发过正文 / 工具调用 */
  private streamedText = false;
  private streamedTool = false;
  /** 已经展开过的条目 */
  private readonly expanded = new Set<string>();

  push(ev: SseEvent): SseEvent[] {
    const j = parse(ev.data);
    if (!j) return [ev];
    const type = typeof j.type === 'string' ? j.type : (ev.event ?? '');
    if (isResponsesKeepAlive(j) || (type && !RESPONSES_EVENTS.has(type))) return [];
    switch (type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        this.streamedText = true;
        return [ev];
      case 'response.output_item.added':
        if (isObj(j.item) && j.item.type === 'function_call') this.streamedTool = true;
        return [ev];
      case 'response.output_item.done': {
        const item = isObj(j.item) ? j.item : null;
        const i = typeof j.output_index === 'number' ? j.output_index : 0;
        return item ? [...this.expand(item, i, false), ev] : [ev];
      }
      case 'response.completed':
      case 'response.incomplete': {
        const r = isObj(j.response) ? j.response : {};
        const output = Array.isArray(r.output) ? (r.output as unknown[]) : [];
        const out: SseEvent[] = [];
        output.forEach((it, i) => {
          if (isObj(it)) out.push(...this.expand(it, i, true));
        });
        out.push(ev);
        return out;
      }
      default:
        return [ev];
    }
  }

  /** 一个完整条目 → 规范的增量事件（还没发过时）；withDone：后面没有上游的 done，要自己补 */
  private expand(item: Obj, index: number, withDone: boolean): SseEvent[] {
    const id = typeof item.id === 'string' ? item.id : '';
    if (item.type === 'message') {
      const key = id || `#msg${index}`;
      if (this.streamedText || this.expanded.has(key)) return [];
      this.expanded.add(key);
      const text = itemText(item);
      if (!text) return [];
      return [
        this.event('response.output_text.delta', {
          item_id: id,
          output_index: index,
          content_index: 0,
          delta: text,
        }),
      ];
    }
    if (item.type !== 'function_call' || this.streamedTool) return [];
    const callId = typeof item.call_id === 'string' ? item.call_id : '';
    const key = id || callId;
    if (!key || this.expanded.has(key)) return [];
    this.expanded.add(key);
    const full = { ...item, id: key, call_id: callId || key, status: 'completed' };
    const out = [this.event('response.output_item.added', { output_index: index, item: full })];
    if (withDone)
      out.push(this.event('response.output_item.done', { output_index: index, item: full }));
    return out;
  }

  private event(type: string, body: Obj): SseEvent {
    return { event: type, data: JSON.stringify({ type, ...body }) };
  }
}

/** 按上游协议建解码前的规范化；不需要的协议返回 null */
export function createUpstreamCanonicalizer(wire: CanonicalWire): UpstreamCanonicalizer | null {
  if (wire === 'chat') return new ChatUpstream();
  if (wire === 'responses') return new ResponsesUpstream();
  return null;
}
