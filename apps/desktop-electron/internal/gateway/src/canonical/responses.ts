/**
 * Responses 流的规范化（docs/design/cli-plugin-architecture.md §6.4）：让事件流满足规范表
 * （spec/responses.ts），给按官方结构严格解析的客户端（Grok Build 用 serde 反序列化，缺任何一个
 * 必填字段就报「serialization error」丢掉整轮）。第三方中转站的流常常不完整，这里按事件补齐：
 * - 事件白名单：中转站的保活事件（伪装成 `response.output_text.delta`，item_id 为 SSE-Keep-Alive）
 *   与不在规范全集里的自定义事件（如 response.metadata）丢弃；
 * - 必填字段：response 的 id / object / status / created_at / model / output；message 条目的 id / role /
 *   status / content；output_text 部分的 annotations；reasoning 条目的 summary；function_call 的
 *   call_id / arguments；增量事件的 item_id / output_index / content_index；
 * - 序号：只给缺失的事件补 sequence_number（上一个 + 1），从不改写上游已有的序号；
 * - usage 缺 input_tokens_details / output_tokens_details 时补成 0（只补缺的，不改已有值）；
 * - 空输出回退：response.completed 里 output 是空数组（实测 amux）时，按 output_item.done 收集的条目补上。
 * 没缺字段的事件原样输出（同协议透传时字节不变）。
 */
import {
  RESPONSES_CONTENT_INDEX_EVENT,
  RESPONSES_EVENTS,
  RESPONSES_ITEM_EVENT,
} from '../spec/responses';
import { SseSplitter } from '../stream/sse';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export const NOTE_RESPONSES_DROPPED = '已丢掉 Responses 流里的保活 / 非规范事件';
export const NOTE_RESPONSES_FILLED = '已补齐 Responses 流里缺失的必填字段';

/** 中转站的保活事件（不是协议事件，客户端严格解析会失败） */
export function isResponsesKeepAlive(ev: Obj): boolean {
  return ev['SSE-Keep-Alive'] === true || ev.item_id === 'SSE-Keep-Alive';
}

/** 只补缺的字段；一个都不缺时返回原对象（调用方按引用判断有没有改） */
function fill(o: Obj, defaults: Obj): Obj {
  let out = o;
  for (const [k, v] of Object.entries(defaults)) {
    if (out[k] === undefined || out[k] === null) {
      if (out === o) out = { ...o };
      out[k] = v;
    }
  }
  return out;
}

/** output_text 部分补 annotations */
function completePart(part: unknown): unknown {
  if (!isObj(part) || part.type !== 'output_text' || Array.isArray(part.annotations)) return part;
  return { ...part, annotations: [] };
}

/** 一个输出条目补齐必填字段；id 缺失时用 fallbackId */
function completeItem(item: unknown, status = 'completed', fallbackId = ''): unknown {
  if (!isObj(item)) return item;
  let out = item;
  if (item.type === 'message') {
    out = fill(item, { id: fallbackId, role: 'assistant', status, content: [] });
    const content = Array.isArray(out.content) ? out.content : [];
    if (content.some((p) => completePart(p) !== p))
      out = { ...out, content: content.map(completePart) };
  } else if (item.type === 'reasoning') {
    out = Array.isArray(item.summary) ? item : { ...item, summary: [] };
  } else if (item.type === 'function_call') {
    out = fill(item, {
      ...(typeof item.id === 'string' ? { call_id: item.id } : {}),
      arguments: '',
    });
  }
  return out;
}

function completeOutput(output: unknown): unknown {
  if (!Array.isArray(output) || !output.some((x) => completeItem(x) !== x)) return output;
  return output.map((x) => completeItem(x));
}

/** 补全一个 usage 对象；不是对象时原样返回 */
export function completeResponsesUsage(u: unknown): unknown {
  if (!isObj(u)) return u;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  return {
    ...u,
    input_tokens: input,
    output_tokens: output,
    total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : input + output,
    input_tokens_details: {
      cached_tokens: 0,
      ...(isObj(u.input_tokens_details) ? u.input_tokens_details : {}),
    },
    output_tokens_details: {
      reasoning_tokens: 0,
      ...(isObj(u.output_tokens_details) ? u.output_tokens_details : {}),
    },
  };
}

/** 非流式响应体（或流式事件里的 response 对象）：usage 与条目补齐 */
export function completeResponsesBody(body: unknown, model = ''): unknown {
  // 错误体等不是 response 对象的不动
  if (!isObj(body) || !(body.object === 'response' || 'output' in body || 'usage' in body))
    return body;
  let out = fill(body, {
    id: `resp_nomi_${Date.now().toString(36)}`,
    object: 'response',
    status: 'completed',
    created_at: Math.floor(Date.now() / 1000),
    model,
    output: [],
  });
  const output = completeOutput(out.output);
  if (output !== out.output) out = { ...out, output };
  if (isObj(out.usage)) out = { ...out, usage: completeResponsesUsage(out.usage) };
  return out === body ? body : out;
}

/** 事件类型 → response.status */
function statusOf(type: string): string {
  if (type === 'response.completed') return 'completed';
  if (type === 'response.incomplete') return 'incomplete';
  if (type === 'response.failed') return 'failed';
  return 'in_progress';
}

/**
 * 流式：按事件规范化（见文件头）。输入、输出都是 SSE 文本分片。
 */
export class ResponsesCanonicalizer {
  /** 这一级做过的修正（去重；记请求备注） */
  readonly notes: string[] = [];
  private readonly split = new SseSplitter();
  /** response.output_item.done 收集到的条目（按 output_index） */
  private readonly items: unknown[] = [];
  /** 最近一个事件的 sequence_number（给缺序号的事件接着编） */
  private seq = -1;
  /** 上游第一次给的 response id / 创建时间（后面的事件缺了沿用） */
  private respId = '';
  private createdAt = 0;
  /** 条目 id ↔ output_index（增量事件缺字段时互相补） */
  private readonly idAt = new Map<number, string>();
  private readonly indexOf = new Map<string, number>();
  private lastIndex = 0;

  /** model：上游没给 response.model 时用的模型名（对外的模型名） */
  constructor(private readonly model = '') {}

  push(text: string): string {
    let out = '';
    // 事件之间的空行可以是 LF 或 CRLF（与 SseParser 一致）；分隔符原样保留（#94）
    for (const b of this.split.push(text)) out += this.patch(b.body + b.sep);
    return out;
  }

  end(): string {
    const rest = this.split.take();
    return rest ? this.patch(rest) : '';
  }

  private itemId(i: number): string {
    let id = this.idAt.get(i);
    if (!id) {
      id = `item_nomi_${i}`;
      this.idAt.set(i, id);
      this.indexOf.set(id, i);
    }
    return id;
  }

  private remember(item: unknown, i: number) {
    this.lastIndex = i;
    if (isObj(item) && typeof item.id === 'string' && item.id) {
      this.idAt.set(i, item.id);
      this.indexOf.set(item.id, i);
    }
  }

  private event(orig: Obj): Obj {
    let ev = orig;
    const type = typeof ev.type === 'string' ? ev.type : '';
    if (typeof ev.sequence_number === 'number') this.seq = ev.sequence_number;
    else if (type) ev = { ...ev, sequence_number: ++this.seq };

    if (isObj(ev.item)) {
      const i = typeof ev.output_index === 'number' ? ev.output_index : this.items.length;
      this.remember(ev.item, i);
      const added = type === 'response.output_item.added';
      const item = completeItem(ev.item, added ? 'in_progress' : 'completed', this.itemId(i));
      ev = { ...fill(ev, { output_index: i }), item };
      if (type === 'response.output_item.done') this.items[i] = item;
    } else if (RESPONSES_ITEM_EVENT.test(type)) {
      const id = typeof ev.item_id === 'string' && ev.item_id ? ev.item_id : '';
      const i =
        typeof ev.output_index === 'number'
          ? ev.output_index
          : id && this.indexOf.has(id)
            ? this.indexOf.get(id)!
            : this.lastIndex;
      ev = fill(ev, {
        item_id: id || this.itemId(i),
        output_index: i,
        ...(RESPONSES_CONTENT_INDEX_EVENT.test(type) ? { content_index: 0 } : {}),
      });
      if (isObj(ev.part)) {
        const part = completePart(ev.part);
        if (part !== ev.part) ev = { ...ev, part };
      }
    }

    if (isObj(ev.response)) {
      let response: Obj = ev.response;
      if (typeof response.id === 'string' && response.id) this.respId ||= response.id;
      if (typeof response.created_at === 'number') this.createdAt ||= response.created_at;
      response = fill(response, {
        id: this.respId || (this.respId = `resp_nomi_${Date.now().toString(36)}`),
        object: 'response',
        status: statusOf(type),
        created_at: this.createdAt || (this.createdAt = Math.floor(Date.now() / 1000)),
        model: this.model,
      });
      const emptyOutput = !Array.isArray(response.output) || response.output.length === 0;
      if (emptyOutput && this.items.length && /completed|incomplete|failed/.test(type))
        response = { ...response, output: this.items.filter(Boolean) };
      else if (!Array.isArray(response.output)) response = { ...response, output: [] };
      response = completeResponsesBody(response, this.model) as Obj;
      if (response !== ev.response) ev = { ...ev, response };
    }
    return ev;
  }

  private patch(block: string): string {
    // 奇数位是换行符本身（LF / CRLF），只改数据行，换行原样拼回
    const parts = block.split(/(\r?\n)/);
    let changed = false;
    let drop = false;
    const next = parts.map((line, idx) => {
      if (idx % 2 || !line.startsWith('data:')) return line;
      const raw = line.slice(5).trim();
      let orig: Obj;
      try {
        const v: unknown = JSON.parse(raw);
        if (!isObj(v)) return line;
        orig = v;
      } catch {
        return line;
      }
      const type = orig.type;
      if (isResponsesKeepAlive(orig) || (typeof type === 'string' && !RESPONSES_EVENTS.has(type))) {
        drop = true;
        return line;
      }
      const ev = this.event(orig);
      if (ev === orig || JSON.stringify(ev) === JSON.stringify(orig)) return line;
      changed = true;
      return `data: ${JSON.stringify(ev)}`;
    });
    if (drop) {
      if (!this.notes.includes(NOTE_RESPONSES_DROPPED)) this.notes.push(NOTE_RESPONSES_DROPPED);
      return '';
    }
    if (changed && !this.notes.includes(NOTE_RESPONSES_FILLED))
      this.notes.push(NOTE_RESPONSES_FILLED);
    return changed ? next.join('') : block;
  }
}
