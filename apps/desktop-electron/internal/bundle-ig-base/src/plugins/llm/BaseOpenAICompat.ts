import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  LLMProvider,
} from '../../types/common';

export interface OpenAICompatOptions {
  id: string;
  baseURL: string;
  apiKey?: string;
  /** `request.model` 为空或为 `'default'` 时使用的模型 id */
  defaultModel?: string;
  /** 为 true 时缺少 apiKey 直接报错（云端服务）；本地服务（Ollama / llama.cpp）为 false */
  requiresApiKey?: boolean;
  defaultHeaders?: Record<string, string>;
  /** 由 provider 覆盖以做请求/响应差异适配 */
  buildBody?: (req: ChatRequest) => Record<string, unknown>;
  parseChunk?: (raw: unknown) => ChatChunk | ChatChunk[] | undefined;
  parseResponse?: (raw: unknown, req: ChatRequest) => ChatResponse;
  fetchImpl?: typeof fetch;
}

type FinishReason = ChatResponse['finishReason'];

interface OpenAIToolCall {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChoice {
  message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
  delta?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
  finish_reason?: string | null;
}

interface OpenAIPayload {
  choices?: OpenAIChoice[];
  usage?: unknown;
  error?: { message?: string } | string;
}

function normalizeFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'length':
    case 'tool_calls':
    case 'content_filter':
      return raw;
    case 'function_call':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

/**
 * OpenAI 兼容层 —— `POST ${baseURL}/chat/completions`，归一非流响应、SSE 流式解析、
 * tool_call 结构映射与 usage 字段。OpenAI / DeepSeek / Ollama / llama.cpp / Qwen / Doubao 共用。
 */
export class BaseOpenAICompat implements LLMProvider {
  readonly id: string;
  protected readonly opts: OpenAICompatOptions;
  protected readonly aborts = new Map<string, AbortController>();

  constructor(opts: OpenAICompatOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const res = await this.post(request, false);
    try {
      const raw = (await res.json()) as unknown;
      if (this.opts.parseResponse) return this.opts.parseResponse(raw, request);
      const payload = raw as OpenAIPayload;
      const choice = payload.choices?.[0];
      const toolCalls = choice?.message?.tool_calls
        ?.filter((t) => t.function?.name)
        .map((t, i) => ({
          id: t.id ?? `call_${i}`,
          name: t.function!.name!,
          argumentsJson: t.function?.arguments ?? '{}',
        }));
      return {
        reqId: request.reqId,
        provider: this.id,
        model: this.resolveModel(request),
        content: choice?.message?.content ?? '',
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: normalizeFinishReason(choice?.finish_reason),
        usage: this.normalizeUsage(payload.usage),
        raw,
      };
    } finally {
      this.aborts.delete(request.reqId);
    }
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    let res: Response;
    try {
      res = await this.post(request, true);
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
      return;
    }
    let finished = false;
    try {
      if (!res.body) throw new Error(`[${this.id}] empty response body`);
      for await (const data of readSseData(res.body)) {
        if (data === '[DONE]') break;
        let raw: unknown;
        try {
          raw = JSON.parse(data);
        } catch {
          continue;
        }
        const chunks = this.opts.parseChunk ? this.opts.parseChunk(raw) : this.parseChunk(raw);
        if (!chunks) continue;
        for (const c of Array.isArray(chunks) ? chunks : [chunks]) {
          if (c.type === 'done') finished = true;
          yield c;
        }
      }
      if (!finished) yield { type: 'done', finishReason: 'stop' };
    } catch (err) {
      const aborted = (err as { name?: string } | null)?.name === 'AbortError';
      if (aborted) {
        if (!finished) yield { type: 'done', finishReason: 'stop' };
      } else {
        yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      this.aborts.delete(request.reqId);
    }
  }

  abort(reqId: string): void {
    this.aborts.get(reqId)?.abort();
    this.aborts.delete(reqId);
  }

  /** `'default'` / 空模型 → provider 默认模型 */
  protected resolveModel(request: ChatRequest): string {
    const m = request.model;
    if (m && m !== 'default') return m;
    if (this.opts.defaultModel) return this.opts.defaultModel;
    throw new Error(`[${this.id}] no model specified and provider has no default model`);
  }

  protected buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    if (this.opts.buildBody) return { ...this.opts.buildBody(request), stream };
    const body: Record<string, unknown> = {
      model: this.resolveModel(request),
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      stream,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parametersJsonSchema },
      }));
    }
    return body;
  }

  protected parseChunk(raw: unknown): ChatChunk[] | undefined {
    const payload = raw as OpenAIPayload;
    if (payload.error) {
      const msg = typeof payload.error === 'string' ? payload.error : payload.error.message;
      return [{ type: 'error', error: msg ?? 'unknown error' }];
    }
    const out: ChatChunk[] = [];
    const choice = payload.choices?.[0];
    const delta = choice?.delta;
    if (delta?.content) out.push({ type: 'delta', content: delta.content });
    for (const t of delta?.tool_calls ?? []) {
      out.push({
        type: 'tool_call.delta',
        index: t.index ?? 0,
        name: t.function?.name,
        argumentsJson: t.function?.arguments,
      });
    }
    const usage = this.normalizeUsage(payload.usage);
    if (usage) out.push({ type: 'usage', usage });
    if (choice?.finish_reason) {
      out.push({ type: 'done', finishReason: normalizeFinishReason(choice.finish_reason) });
    }
    return out.length > 0 ? out : undefined;
  }

  private async post(request: ChatRequest, stream: boolean): Promise<Response> {
    if (this.opts.requiresApiKey && !this.opts.apiKey) {
      throw new Error(`[${this.id}] API key is not configured`);
    }
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) throw new Error(`[${this.id}] fetch is not available in this runtime`);

    const controller = new AbortController();
    this.aborts.set(request.reqId, controller);
    const onExternalAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      ...this.opts.defaultHeaders,
    };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;

    let res: Response;
    try {
      res = await fetchImpl(`${this.opts.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(this.buildBody(request, stream)),
        signal: controller.signal,
      });
    } catch (err) {
      this.aborts.delete(request.reqId);
      throw err;
    }
    if (!res.ok) {
      this.aborts.delete(request.reqId);
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      throw new Error(`[${this.id}] HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res;
  }

  /** 归一 usage —— 各家字段命名不同 */
  protected normalizeUsage(raw: unknown): ChatUsage | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, number>;
    const promptTokens = r.prompt_tokens ?? r.input_tokens ?? r.promptTokens ?? 0;
    const completionTokens = r.completion_tokens ?? r.output_tokens ?? r.completionTokens ?? 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: r.total_tokens ?? promptTokens + completionTokens,
    };
  }
}

/** 逐条产出 SSE `data:` 字段（多行 data 以 \n 拼接） */
async function* readSseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const data = extractData(event);
        if (data !== undefined) yield data;
      }
    }
    buf += decoder.decode();
    const data = extractData(buf);
    if (data !== undefined) yield data;
  } finally {
    reader.releaseLock();
  }
}

function extractData(event: string): string | undefined {
  const lines = event
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''));
  return lines.length > 0 ? lines.join('\n') : undefined;
}
