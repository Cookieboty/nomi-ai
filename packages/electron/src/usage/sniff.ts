/**
 * 从本地路由经过的上游响应里取 usage（非流式 JSON / 流式 SSE），不改动转发的内容。
 * 覆盖四种上游：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Gemini。
 * 返回口径：input = 未命中缓存的输入；cacheRead / cacheWrite 另计；output 含推理 token。
 */

export interface SniffedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  model?: string;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** 从一个 JSON 对象（整包响应或一个 SSE 事件）里取出 usage 片段；没有则返回 null */
export function usageFromObject(raw: unknown): Partial<SniffedUsage> | null {
  const o = obj(raw);
  if (!o) return null;
  // Gemini：usageMetadata（可能包在 response 里）
  const gm = obj(o.usageMetadata) ?? obj(obj(o.response)?.usageMetadata);
  if (gm) {
    const cached = num(gm.cachedContentTokenCount);
    return {
      input: Math.max(0, num(gm.promptTokenCount) - cached),
      output: num(gm.candidatesTokenCount) + num(gm.thoughtsTokenCount),
      cacheRead: cached,
      cacheWrite: 0,
      model: typeof o.modelVersion === 'string' ? o.modelVersion : undefined,
    };
  }
  // Anthropic message_start：message.usage；message_delta：顶层 usage；非流式：顶层 usage
  const msg = obj(o.message);
  const resp = obj(o.response);
  const u = obj(o.usage) ?? obj(msg?.usage) ?? obj(resp?.usage);
  if (!u) return null;
  const model =
    (typeof o.model === 'string' && o.model) ||
    (typeof msg?.model === 'string' && msg.model) ||
    (typeof resp?.model === 'string' && resp.model) ||
    undefined;
  // Anthropic 口径
  if (
    'input_tokens' in u &&
    ('cache_read_input_tokens' in u ||
      'cache_creation_input_tokens' in u ||
      !('input_tokens_details' in u))
  ) {
    const cc = obj(u.cache_creation);
    return {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite:
        num(u.cache_creation_input_tokens) ||
        num(cc?.ephemeral_5m_input_tokens) + num(cc?.ephemeral_1h_input_tokens),
      model,
    };
  }
  // OpenAI Responses：input_tokens 含缓存（input_tokens_details.cached_tokens）
  if ('input_tokens' in u) {
    const cached = num(obj(u.input_tokens_details)?.cached_tokens);
    return {
      input: Math.max(0, num(u.input_tokens) - cached),
      output: num(u.output_tokens),
      cacheRead: cached,
      cacheWrite: 0,
      model,
    };
  }
  // Anthropic message_delta：只带最终输出 token
  if ('output_tokens' in u) {
    return { input: 0, output: num(u.output_tokens), cacheRead: 0, cacheWrite: 0, model };
  }
  // OpenAI Chat Completions
  if ('prompt_tokens' in u || 'completion_tokens' in u) {
    const d = obj(u.prompt_tokens_details);
    const cached = num(d?.cached_tokens);
    return {
      input: Math.max(0, num(u.prompt_tokens) - cached),
      output: num(u.completion_tokens),
      cacheRead: cached,
      cacheWrite: 0,
      model,
    };
  }
  return null;
}

/** 合并同一次响应里先后出现的 usage 片段：Anthropic 的 start 给输入、delta 给最终输出 → 取各字段最大值 */
export function mergeUsage(a: SniffedUsage, b: Partial<SniffedUsage>): SniffedUsage {
  return {
    input: Math.max(a.input, b.input ?? 0),
    output: Math.max(a.output, b.output ?? 0),
    cacheRead: Math.max(a.cacheRead, b.cacheRead ?? 0),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite ?? 0),
    model: b.model || a.model,
  };
}

export const emptySniffed = (): SniffedUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export const hasTokens = (u: SniffedUsage): boolean =>
  u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0;

/** 增量 SSE 嗅探：喂入上游原始文本片段，持续累计 usage（不保存正文） */
export class SseUsageTap {
  private buf = '';
  usage: SniffedUsage = emptySniffed();

  push(text: string): void {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      this.line(line);
    }
    // 防御：超长无换行内容不无限累积
    if (this.buf.length > 4 * 1024 * 1024) this.buf = '';
  }

  end(): SniffedUsage {
    this.line(this.buf.trim());
    this.buf = '';
    return this.usage;
  }

  private line(line: string): void {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const part = usageFromObject(JSON.parse(data));
      if (part) this.usage = mergeUsage(this.usage, part);
    } catch {
      /* 非 JSON 事件忽略 */
    }
  }
}
