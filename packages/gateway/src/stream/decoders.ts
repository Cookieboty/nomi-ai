/**
 * 上游 SSE → 中间事件。
 * 覆盖：OpenAI Chat Completions、OpenAI Responses、Gemini streamGenerateContent(alt=sse)、Anthropic Messages。
 * 解码器只做协议翻译，假定输入是规范事件流（§6.4）：createDecoder 先接上解码前的规范化
 * （canonical/upstream.ts：Chat 字段归一、Responses 保活 / 非规范事件、只给完整条目的展开）。
 * 直接 new 各个类的调用方（用量旁路）只读用量，不依赖这些。
 */
import { createUpstreamCanonicalizer } from '../canonical/upstream';
import { GEMINI_FAILED_FINISH } from '../spec/gemini';

import {
  mergeUsage,
  type NormEvent,
  type StopReason,
  type StreamDecoder,
  type StreamUsage,
} from './events';

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

function parseJson(data: string): Obj | null {
  try {
    const v: unknown = JSON.parse(data);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function errorMessage(e: unknown, fallback: string): string {
  const o = asObj(e);
  if (typeof o.message === 'string' && o.message) return o.message;
  if (typeof e === 'string' && e) return e;
  return fallback;
}

/** 公共骨架：保证 start 只发一次、finish/error 之后静默 */
abstract class BaseDecoder implements StreamDecoder {
  protected started = false;
  protected done = false;
  protected sawTool = false;
  protected pendingReason: StopReason | null = null;
  protected usage: StreamUsage = {};
  /** 当前是否处在一段推理里（用于在推理与正文 / 工具之间切换时补 think_start） */
  protected thinking = false;

  /** seed：这一轮的工具调用 id 种子（§6.9.7，按对话历史派生）；空 = 只按序号 */
  constructor(protected readonly seed = '') {}

  /** 上游没给工具调用 id 时的确定性 id */
  protected fallbackId(prefix: string, key: string): string {
    return this.seed ? `${prefix}_${this.seed}_${key}` : `${prefix}_${key}`;
  }

  protected think(out: NormEvent[], text: string, id?: string) {
    if (!this.thinking) {
      this.thinking = true;
      out.push(id ? { type: 'think_start', id } : { type: 'think_start' });
    }
    if (text) out.push({ type: 'think', text });
  }

  protected start(out: NormEvent[], id?: string, model?: string) {
    if (this.started) return;
    this.started = true;
    out.push({ type: 'start', id, model, usage: { ...this.usage } });
  }

  protected finish(out: NormEvent[], reason?: StopReason) {
    if (this.done) return;
    this.start(out);
    this.done = true;
    const r = reason ?? this.pendingReason ?? (this.sawTool ? 'tool_use' : 'end_turn');
    out.push({ type: 'finish', reason: r, usage: { ...this.usage } });
  }

  protected fail(out: NormEvent[], message: string, errorType?: string) {
    if (this.done) return;
    this.done = true;
    out.push({ type: 'error', message, errorType });
  }

  push(ev: { event?: string; data: string }): NormEvent[] {
    const out: NormEvent[] = [];
    if (this.done) return out;
    this.handle(ev, out);
    return out;
  }

  protected abstract handle(ev: { event?: string; data: string }, out: NormEvent[]): void;

  /** 收到过结束标记（Chat 的 finish_reason / [DONE]、Messages 的 stop_reason / message_stop、
   * Responses 的 completed / incomplete / failed、Gemini 的 finishReason）或错误 */
  get terminated(): boolean {
    return this.done || this.pendingReason !== null;
  }

  /**
   * 上游流结束。没有任何结束标记就断了（连接被中转站掐断、只发了保活等）按错误结束：
   * 当成正常完成的话，客户端拿到的是空回复或截断的正文 / 工具参数，只会静默重试或执行半截调用。
   */
  end(): NormEvent[] {
    const out: NormEvent[] = [];
    if (!this.done) {
      if (this.pendingReason) this.finish(out);
      else if (!this.started) this.fail(out, 'upstream stream ended without any data', 'api_error');
      else this.fail(out, 'upstream stream ended before completion', 'api_error');
    }
    return out;
  }
}

/* ---------------------------- Chat Completions ---------------------------- */

function chatFinish(r: unknown): StopReason | null {
  switch (r) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case null:
    case undefined:
    case '':
      return null;
    default:
      return 'end_turn';
  }
}

export class ChatCompletionsDecoder extends BaseDecoder {
  /** 已开始的工具调用：key → 调用 id */
  private tools = new Map<string, string>();
  /** 上游的 index → 当前对应的 key（同一 index 换了新的调用 id 时开新 key） */
  private slot = new Map<string, string>();

  protected handle(ev: { event?: string; data: string }, out: NormEvent[]) {
    const data = ev.data.trim();
    if (data === '[DONE]') {
      this.finish(out);
      return;
    }
    const j = parseJson(data);
    if (!j) return;
    if (j.error) {
      const e = asObj(j.error);
      this.fail(out, errorMessage(j.error, 'upstream error'), String(e.type ?? 'api_error'));
      return;
    }
    const usage = asObj(j.usage);
    if (j.usage) {
      this.usage = mergeUsage(this.usage, {
        inputTokens: num(usage.prompt_tokens),
        outputTokens: num(usage.completion_tokens),
        cacheReadTokens: num(asObj(usage.prompt_tokens_details).cached_tokens),
        reasoningTokens: num(asObj(usage.completion_tokens_details).reasoning_tokens),
      });
    }
    this.start(
      out,
      typeof j.id === 'string' ? j.id : undefined,
      typeof j.model === 'string' ? j.model : undefined,
    );
    const choices = Array.isArray(j.choices) ? (j.choices as Obj[]) : [];
    const c = choices[0];
    if (!c) return;
    const delta = asObj(c.delta);
    // DeepSeek / Kimi / GLM 等的思考文本（字段名各家不一）
    const reasoning =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : '';
    if (reasoning) this.think(out, reasoning);
    if (typeof delta.content === 'string' && delta.content) {
      this.thinking = false;
      out.push({ type: 'text', text: delta.content });
    }
    const calls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Obj[]) : [];
    for (const tc of calls) {
      // 同一 index 出现了新的调用 id 并带着工具名，就是另一个调用
      // （只换 id 不带名字的不算：有的上游每个分片都发一个新 id）
      const index = String(tc.index);
      const id = typeof tc.id === 'string' && tc.id ? tc.id : '';
      const fn = asObj(tc.function);
      let key = this.slot.get(index);
      const prev = key ? this.tools.get(key) : undefined;
      if (!key || (id && fn.name && prev && prev !== id)) {
        key = this.tools.has(index) ? `${index}#${this.tools.size}` : index;
        this.slot.set(index, key);
      }
      if (!this.tools.has(key)) {
        this.tools.set(key, id);
        this.sawTool = true;
        this.thinking = false;
        out.push({
          type: 'tool_start',
          key,
          id: id || this.fallbackId('call', key),
          name: String(fn.name ?? ''),
        });
      }
      if (typeof fn.arguments === 'string' && fn.arguments)
        out.push({ type: 'tool_args', key, delta: fn.arguments });
    }
    const r = chatFinish(c.finish_reason);
    if (r) this.pendingReason = r;
  }
}

/* -------------------------------- Responses ------------------------------- */

export class ResponsesDecoder extends BaseDecoder {
  /** output_index / item_id → key */
  private toolKeys = new Map<string, string>();

  private keyFor(j: Obj): string | undefined {
    if (typeof j.item_id === 'string' && this.toolKeys.has(j.item_id)) {
      return this.toolKeys.get(j.item_id);
    }
    const oi = j.output_index;
    if (oi !== undefined && this.toolKeys.has(`#${String(oi)}`)) {
      return this.toolKeys.get(`#${String(oi)}`);
    }
    return undefined;
  }

  private readUsage(resp: Obj) {
    const u = asObj(resp.usage);
    if (!resp.usage) return;
    this.usage = mergeUsage(this.usage, {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(asObj(u.input_tokens_details).cached_tokens),
      reasoningTokens: num(asObj(u.output_tokens_details).reasoning_tokens),
    });
  }

  protected handle(ev: { event?: string; data: string }, out: NormEvent[]) {
    const j = parseJson(ev.data);
    if (!j) return;
    const type = String(j.type ?? ev.event ?? '');
    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        const r = asObj(j.response);
        this.readUsage(r);
        this.start(
          out,
          typeof r.id === 'string' ? r.id : undefined,
          typeof r.model === 'string' ? r.model : undefined,
        );
        return;
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        this.start(out);
        this.thinking = false;
        if (typeof j.delta === 'string' && j.delta) out.push({ type: 'text', text: j.delta });
        return;
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        this.start(out);
        if (typeof j.delta === 'string' && j.delta) this.think(out, j.delta);
        return;
      }
      case 'response.output_item.added': {
        const item = asObj(j.item);
        if (item.type === 'reasoning') {
          this.start(out);
          this.thinking = false;
          this.think(out, '', typeof item.id === 'string' ? item.id : undefined);
          return;
        }
        if (item.type !== 'function_call') return;
        this.thinking = false;
        this.start(out);
        const key = String(item.id ?? `#${String(j.output_index ?? this.toolKeys.size)}`);
        this.toolKeys.set(key, key);
        this.toolKeys.set(`#${String(j.output_index ?? '')}`, key);
        this.sawTool = true;
        out.push({
          type: 'tool_start',
          key,
          id: String(item.call_id ?? item.id ?? key),
          name: String(item.name ?? ''),
        });
        if (typeof item.arguments === 'string' && item.arguments) {
          out.push({ type: 'tool_args', key, delta: item.arguments });
        }
        return;
      }
      case 'response.function_call_arguments.delta': {
        const key = this.keyFor(j);
        if (key && typeof j.delta === 'string' && j.delta) {
          out.push({ type: 'tool_args', key, delta: j.delta });
        }
        return;
      }
      case 'response.function_call_arguments.done':
      case 'response.output_item.done': {
        const item = asObj(j.item);
        if (type === 'response.output_item.done' && item.type === 'reasoning') {
          if (typeof item.encrypted_content === 'string' && item.encrypted_content)
            out.push({ type: 'sealed', by: 'responses', raw: item });
          return;
        }
        if (type === 'response.output_item.done' && item.type !== 'function_call') return;
        const key = this.keyFor(j) ?? (typeof item.id === 'string' ? item.id : undefined);
        if (key && this.toolKeys.has(key)) out.push({ type: 'tool_end', key });
        return;
      }
      case 'response.completed': {
        const r = asObj(j.response);
        this.readUsage(r);
        this.finish(out);
        return;
      }
      case 'response.incomplete': {
        const r = asObj(j.response);
        this.readUsage(r);
        const reason = asObj(r.incomplete_details).reason;
        this.finish(out, reason === 'max_output_tokens' ? 'max_tokens' : undefined);
        return;
      }
      case 'response.failed': {
        const r = asObj(j.response);
        const e = asObj(r.error);
        this.fail(
          out,
          errorMessage(r.error, 'upstream response failed'),
          String(e.code ?? 'api_error'),
        );
        return;
      }
      case 'error': {
        const e = j.error ? asObj(j.error) : j;
        this.fail(out, errorMessage(e, 'upstream error'), String(e.code ?? e.type ?? 'api_error'));
        return;
      }
      default:
        return;
    }
  }
}

/* --------------------------------- Gemini --------------------------------- */

function geminiFinish(r: unknown): StopReason | null {
  if (!r || typeof r !== 'string') return null;
  if (r === 'MAX_TOKENS') return 'max_tokens';
  return 'end_turn';
}

export class GeminiDecoder extends BaseDecoder {
  private toolCount = 0;

  protected handle(ev: { event?: string; data: string }, out: NormEvent[]) {
    const j = parseJson(ev.data);
    if (!j) return;
    if (j.error) {
      const e = asObj(j.error);
      this.fail(out, errorMessage(j.error, 'upstream error'), String(e.status ?? 'api_error'));
      return;
    }
    const um = asObj(j.usageMetadata);
    if (j.usageMetadata) {
      this.usage = mergeUsage(this.usage, {
        inputTokens: num(um.promptTokenCount),
        outputTokens: num(um.candidatesTokenCount),
        cacheReadTokens: num(um.cachedContentTokenCount),
        reasoningTokens: num(um.thoughtsTokenCount),
      });
    }
    this.start(
      out,
      typeof j.responseId === 'string' ? j.responseId : undefined,
      typeof j.modelVersion === 'string' ? j.modelVersion : undefined,
    );
    const cands = Array.isArray(j.candidates) ? (j.candidates as Obj[]) : [];
    const c = cands[0];
    if (!c) {
      const block = asObj(j.promptFeedback).blockReason;
      if (block) this.fail(out, `prompt blocked: ${String(block)}`, 'invalid_request_error');
      return;
    }
    const parts = Array.isArray(asObj(c.content).parts) ? (asObj(c.content).parts as Obj[]) : [];
    for (const p of parts) {
      const sig =
        typeof p.thoughtSignature === 'string' && p.thoughtSignature ? p.thoughtSignature : '';
      if (p.thought === true) {
        this.think(out, typeof p.text === 'string' ? p.text : '');
        if (sig) out.push({ type: 'think_sig', signature: sig });
        continue;
      }
      this.thinking = false;
      if (typeof p.text === 'string' && p.text) out.push({ type: 'text', text: p.text });
      // Gemini 3 把签名挂在正文 / 工具调用部分上，续接时要原样带回
      if (sig) out.push({ type: 'text_sig', signature: sig });
      if (p.functionCall) {
        const fc = asObj(p.functionCall);
        const key = String(this.toolCount++);
        this.sawTool = true;
        out.push({
          type: 'tool_start',
          key,
          id: typeof fc.id === 'string' && fc.id ? fc.id : this.fallbackId('call_gemini', key),
          name: String(fc.name ?? ''),
        });
        out.push({ type: 'tool_args', key, delta: JSON.stringify(fc.args ?? {}) });
        out.push({ type: 'tool_end', key }); // Gemini 的 functionCall 一次给全参数
      }
    }
    const r = geminiFinish(c.finishReason);
    if (r) {
      // Gemini 工具调用的 finishReason 仍为 STOP
      this.pendingReason = r === 'end_turn' && this.sawTool ? 'tool_use' : r;
      const fr = String(c.finishReason);
      if (
        ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(fr) &&
        !this.sawTool
      ) {
        this.fail(out, `response blocked: ${fr}`, 'api_error');
      } else if (GEMINI_FAILED_FINISH.has(fr) && !this.sawTool) {
        // 模型想调用工具但没生成出合法的调用：按错误报，不当成一次空的正常回复
        this.fail(out, `model produced an invalid tool call: ${fr}`, 'api_error');
      }
    }
  }
}

/* --------------------------- Anthropic Messages --------------------------- */

function messagesStop(r: unknown): StopReason | null {
  switch (r) {
    case 'end_turn':
    case 'max_tokens':
    case 'tool_use':
    case 'stop_sequence':
    case 'refusal':
      return r;
    case null:
    case undefined:
      return null;
    default:
      return 'end_turn';
  }
}

export class MessagesDecoder extends BaseDecoder {
  private toolBlocks = new Set<string>();

  protected handle(ev: { event?: string; data: string }, out: NormEvent[]) {
    const j = parseJson(ev.data);
    if (!j) return;
    const type = String(j.type ?? ev.event ?? '');
    switch (type) {
      case 'message_start': {
        const m = asObj(j.message);
        const u = asObj(m.usage);
        this.usage = mergeUsage(
          {},
          {
            inputTokens: num(u.input_tokens),
            outputTokens: num(u.output_tokens),
            cacheReadTokens: num(u.cache_read_input_tokens),
            cacheWriteTokens: num(u.cache_creation_input_tokens),
          },
        );
        this.start(
          out,
          typeof m.id === 'string' ? m.id : undefined,
          typeof m.model === 'string' ? m.model : undefined,
        );
        return;
      }
      case 'content_block_start': {
        const b = asObj(j.content_block);
        this.start(out);
        if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          const key = String(j.index ?? this.toolBlocks.size);
          this.toolBlocks.add(key);
          this.sawTool = true;
          out.push({
            type: 'tool_start',
            key,
            id: String(b.id ?? this.fallbackId('toolu', key)),
            name: String(b.name ?? ''),
          });
          const input = asObj(b.input);
          if (Object.keys(input).length) {
            out.push({ type: 'tool_args', key, delta: JSON.stringify(input) });
          }
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
          out.push({ type: 'text', text: b.text });
        } else if (b.type === 'thinking') {
          this.thinking = false;
          this.think(out, typeof b.thinking === 'string' ? b.thinking : '');
        } else if (b.type === 'redacted_thinking') {
          out.push({ type: 'sealed', by: 'messages', raw: b });
        }
        if (b.type !== 'thinking') this.thinking = false;
        return;
      }
      case 'content_block_delta': {
        const d = asObj(j.delta);
        if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
          out.push({ type: 'text', text: d.text });
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
          this.think(out, d.thinking);
        } else if (d.type === 'signature_delta' && typeof d.signature === 'string' && d.signature) {
          out.push({ type: 'think_sig', signature: d.signature });
        } else if (
          d.type === 'input_json_delta' &&
          typeof d.partial_json === 'string' &&
          d.partial_json
        ) {
          const key = String(j.index ?? '');
          if (this.toolBlocks.has(key)) out.push({ type: 'tool_args', key, delta: d.partial_json });
        }
        return;
      }
      case 'content_block_stop': {
        const key = String(j.index ?? '');
        if (this.toolBlocks.has(key)) out.push({ type: 'tool_end', key });
        return;
      }
      case 'message_delta': {
        const d = asObj(j.delta);
        const r = messagesStop(d.stop_reason);
        if (r) this.pendingReason = r;
        const u = asObj(j.usage);
        if (j.usage) {
          this.usage = mergeUsage(this.usage, {
            inputTokens: num(u.input_tokens),
            outputTokens: num(u.output_tokens),
            cacheReadTokens: num(u.cache_read_input_tokens),
            cacheWriteTokens: num(u.cache_creation_input_tokens),
          });
        }
        return;
      }
      case 'message_stop':
        this.finish(out);
        return;
      case 'error': {
        const e = asObj(j.error);
        this.fail(out, errorMessage(e, 'upstream error'), String(e.type ?? 'api_error'));
        return;
      }
      default:
        return;
    }
  }
}

type DecoderWire = 'chat' | 'responses' | 'gemini' | 'messages';

function pureDecoder(wire: DecoderWire, seed: string): StreamDecoder {
  switch (wire) {
    case 'chat':
      return new ChatCompletionsDecoder(seed);
    case 'responses':
      return new ResponsesDecoder(seed);
    case 'gemini':
      return new GeminiDecoder(seed);
    case 'messages':
      return new MessagesDecoder(seed);
  }
}

/**
 * 按上游协议建解码器：先过解码前的规范化（canonical/upstream.ts），再做纯协议翻译。
 * seed：工具调用 id 的种子（§6.9.7）。
 */
export function createDecoder(wire: DecoderWire, opts: { seed?: string } = {}): StreamDecoder {
  const dec = pureDecoder(wire, opts.seed ?? '');
  const canon = createUpstreamCanonicalizer(wire);
  if (!canon) return dec;
  return {
    push(ev) {
      const out: NormEvent[] = [];
      for (const e of canon.push(ev)) out.push(...dec.push(e));
      return out;
    },
    end: () => dec.end(),
    get terminated() {
      return dec.terminated;
    },
  };
}
