/**
 * Responses 入口的结果补全，给按官方结构严格解析的客户端（Grok Build 用 serde 反序列化，缺任何一个
 * 必填字段就报「serialization error」丢掉整轮）。第三方中转站的流常常不完整，这里按事件补齐：
 * - 必填字段（对 Grok 1.0.67 逐项实测）：
 *   response 的 id / object / status / created_at / model / output；message 条目的 id / role / status /
 *   content；output_text 部分的 annotations；reasoning 条目的 summary；function_call 的 call_id /
 *   arguments；增量事件的 item_id / output_index / content_index；每个事件的 sequence_number；
 * - usage 缺 input_tokens_details / output_tokens_details 时补成 0（只补缺的，不改已有值）；
 * - response.completed 里 output 是空数组（实测 amux）时，Grok 以它为准、认为这一轮什么都没输出
 *   而反复重试：按 response.output_item.done 收集的条目补上；
 * - 中转站的保活事件伪装成 `response.output_text.delta`（item_id 为 SSE-Keep-Alive），以及不在官方
 *   事件列表里的自定义事件（如 response.metadata），直接丢弃。
 * 没缺字段的事件原样透传（同协议透传时字节不变）。
 */
type Obj = Record<string, unknown>;

/** 一个事件的结尾：空行（LF 或 CRLF，可混用） */
const EVENT_END = /\r?\n\r?\n/;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * 官方 Responses 流的全部事件类型（与 Grok 1.0.67 反序列化接受的列表逐项一致）。
 * 中转站自己加的事件（实测 amux 的 response.metadata）不在其中：严格客户端遇到未知类型直接
 * 报错丢掉整轮，宽松客户端（Codex）本来也会忽略，所以一律丢弃。
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

/** 带 content_index 的增量 / 完成事件 */
const CONTENT_EVENT = /^response\.(output_text|refusal|content_part)\./;
/** 指向某个条目（item_id + output_index）的事件 */
const ITEM_EVENT =
  /^response\.(output_text|refusal|content_part|function_call_arguments|reasoning_summary_text|reasoning_summary_part|reasoning_text|custom_tool_call_input)\./;

/**
 * 流式：按事件补齐（见文件头）。
 */
export class ResponsesUsagePatcher {
  private buf = '';
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
    this.buf += text;
    let out = '';
    // 事件之间的空行可以是 LF 或 CRLF（与 SseParser 一致）；分隔符原样保留（#94）
    for (let m = EVENT_END.exec(this.buf); m; m = EVENT_END.exec(this.buf)) {
      const end = m.index + m[0].length;
      out += this.patch(this.buf.slice(0, end));
      this.buf = this.buf.slice(end);
    }
    return out;
  }

  end(): string {
    const rest = this.buf;
    this.buf = '';
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
    } else if (ITEM_EVENT.test(type)) {
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
        ...(CONTENT_EVENT.test(type) ? { content_index: 0 } : {}),
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
    if (drop) return '';
    return changed ? next.join('') : block;
  }
}
