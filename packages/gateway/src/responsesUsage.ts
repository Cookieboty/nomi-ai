/**
 * Responses 入口的结果补全，给按官方结构严格解析的客户端（实测 Grok Build 1.0.62）：
 * - usage 缺 input_tokens_details / output_tokens_details 时 Grok 报「serialization error」丢掉整轮，
 *   这里补成 0（只补缺的，不改已有值）；
 * - 中转站（实测 amux）的 response.completed 里 output 是空数组，Grok 以它为准、认为这一轮什么都没输出
 *   而反复重试。流式时按 response.output_item.done 收集的条目补上。
 */
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

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

/** 非流式响应体（或流式事件里的 response 对象） */
export function completeResponsesBody(body: unknown): unknown {
  if (!isObj(body) || !isObj(body.usage)) return body;
  return { ...body, usage: completeResponsesUsage(body.usage) };
}

/**
 * 流式：按事件补全 response.completed / incomplete / failed 里的 response.usage。
 * 其它事件原样透传（同协议透传时字节不变）。
 */
export class ResponsesUsagePatcher {
  private buf = '';
  /** response.output_item.done 收集到的条目（按 output_index） */
  private readonly items: unknown[] = [];

  push(text: string): string {
    this.buf += text;
    let out = '';
    let i: number;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      out += this.patch(this.buf.slice(0, i + 2));
      this.buf = this.buf.slice(i + 2);
    }
    return out;
  }

  end(): string {
    const rest = this.buf;
    this.buf = '';
    return rest ? this.patch(rest) : '';
  }

  private patch(block: string): string {
    const watch = block.includes('"usage"') || block.includes('output_item.done');
    if (!watch) return block;
    const lines = block.split('\n');
    let changed = false;
    const next = lines.map((line) => {
      if (!line.startsWith('data:')) return line;
      const raw = line.slice(5).trim();
      try {
        const ev = JSON.parse(raw) as Obj;
        if (ev.type === 'response.output_item.done' && isObj(ev.item)) {
          const i = typeof ev.output_index === 'number' ? ev.output_index : this.items.length;
          this.items[i] = ev.item;
          return line;
        }
        if (!isObj(ev.response)) return line;
        let response: Obj = ev.response;
        const emptyOutput = !Array.isArray(response.output) || response.output.length === 0;
        if (emptyOutput && this.items.length)
          response = { ...response, output: this.items.filter(Boolean) };
        if (isObj(response.usage)) response = completeResponsesBody(response) as Obj;
        if (response === ev.response) return line;
        changed = true;
        return `data: ${JSON.stringify({ ...ev, response })}`;
      } catch {
        return line;
      }
    });
    return changed ? next.join('\n') : block;
  }
}
