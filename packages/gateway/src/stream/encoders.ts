/**
 * 中间事件 → 下游 CLI 期望的 SSE。
 * Messages（Claude Code 原生）、Responses（Codex 原生）、Chat Completions（Codex chat 入口）。
 * 工具调用 id 按入口协议的格式写（Messages 的 tool_use.id 只接受 [A-Za-z0-9_-]，§6.9.7），
 * Responses 的条目 id 由 call_id 确定地派生（不随机），历史逐字节一致。
 */
import { escapeCallId } from '../models/rules/response/callIds';

import { customToolInput } from './aggregate';
import { geminiErrorStatus } from './errors';
import type { NormEvent, StopReason, StreamEncoder, StreamUsage } from './events';
import { HEARTBEAT_COMMENT, HEARTBEAT_PING } from './heartbeat';
import { SerialBlocks, type SerialBlock, type SerialSink } from './serial';
import { formatSse } from './sse';

function rid(prefix: string): string {
  return `${prefix}_nomi_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* --------------------------- Anthropic Messages --------------------------- */

export class MessagesEncoder implements StreamEncoder {
  private started = false;
  private closed = false;
  private nextIndex = 0;
  private usage: StreamUsage = {};
  private readonly index = new Map<SerialBlock, number>();
  /** 串行化：同一时刻只有一个 content block 打开，交错的工具参数先缓存（见 serial.ts） */
  private readonly blocks = new SerialBlocks({
    open: (b) => {
      const index = this.nextIndex++;
      this.index.set(b, index);
      return formatSse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block:
          b.kind === 'text'
            ? { type: 'text', text: '' }
            : { type: 'tool_use', id: escapeCallId(b.id ?? ''), name: b.name, input: {} },
      });
    },
    delta: (b, d) =>
      formatSse('content_block_delta', {
        type: 'content_block_delta',
        index: this.index.get(b),
        delta:
          b.kind === 'text'
            ? { type: 'text_delta', text: d }
            : { type: 'input_json_delta', partial_json: d },
      }),
    close: (b) =>
      formatSse('content_block_stop', { type: 'content_block_stop', index: this.index.get(b) }),
  });

  constructor(private readonly fallbackModel = '') {}

  private ensureStart(id?: string, model?: string, usage?: StreamUsage): string {
    if (this.started) return '';
    this.started = true;
    if (usage) this.usage = { ...usage };
    return formatSse('message_start', {
      type: 'message_start',
      message: {
        id: id || rid('msg'),
        type: 'message',
        role: 'assistant',
        content: [],
        model: model || this.fallbackModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.usage.inputTokens ?? 0, output_tokens: 0 },
      },
    });
  }

  encode(ev: NormEvent): string {
    if (this.closed) return '';
    switch (ev.type) {
      case 'start':
        return this.ensureStart(ev.id, ev.model, ev.usage);
      case 'text':
        return this.ensureStart() + this.blocks.text(ev.text);
      case 'tool_start':
        return this.ensureStart() + this.blocks.toolStart(ev.key, ev.id, ev.name);
      case 'tool_args':
        return this.blocks.toolArgs(ev.key, ev.delta);
      case 'tool_end':
        return this.blocks.toolEnd(ev.key);
      case 'finish': {
        this.closed = true;
        const usage = { ...this.usage, ...stripUndef(ev.usage) };
        return (
          this.ensureStart() +
          this.blocks.finish() +
          formatSse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: ev.reason, stop_sequence: null },
            // Chat/Gemini 上游的输入用量只在流尾给出，随 message_delta 一并补报
            usage: {
              ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
              output_tokens: usage.outputTokens ?? 0,
            },
          }) +
          formatSse('message_stop', { type: 'message_stop' })
        );
      }
      case 'error':
        this.closed = true;
        return formatSse('error', {
          type: 'error',
          error: { type: messagesErrorType(ev.errorType), message: ev.message },
        });
      case 'alive':
        // 官方协议的 ping 只在 message_start 之后出现；之前用 SSE 注释
        return this.started ? HEARTBEAT_PING : HEARTBEAT_COMMENT;
      default:
        return '';
    }
  }

  end(): string {
    return '';
  }
}

function messagesErrorType(t?: string): string {
  const known = [
    'invalid_request_error',
    'authentication_error',
    'permission_error',
    'not_found_error',
    'rate_limit_error',
    'api_error',
    'overloaded_error',
  ];
  return t && known.includes(t) ? t : 'api_error';
}

function stripUndef(u?: StreamUsage): StreamUsage {
  const o: StreamUsage = {};
  if (u?.inputTokens !== undefined) o.inputTokens = u.inputTokens;
  if (u?.outputTokens !== undefined) o.outputTokens = u.outputTokens;
  return o;
}

/* -------------------------------- Responses ------------------------------- */

type RespItem =
  | { type: 'message'; id: string; text: string }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  /** 自由文本工具：参数增量按 {"input": ...} 累积，结束时还原为原始字符串 */
  | { type: 'custom_tool_call'; id: string; call_id: string; name: string; arguments: string };

export class ResponsesEncoder implements StreamEncoder {
  private seq = 0;
  private started = false;
  private closed = false;
  private id = '';
  private model: string;
  private createdAt = Math.floor(Date.now() / 1000);
  private items: RespItem[] = [];
  private usage: StreamUsage = {};
  private readonly itemIndex = new Map<SerialBlock, number>();
  /** 串行化：同一时刻只有一个 output item 打开，交错的工具参数先缓存（见 serial.ts） */
  private readonly blocks: SerialBlocks;

  constructor(
    fallbackModel = '',
    private readonly customTools: ReadonlySet<string> = new Set(),
  ) {
    this.model = fallbackModel;
    this.blocks = new SerialBlocks(this.sink());
  }

  private sink(): SerialSink {
    return {
      open: (b) => {
        let s = '';
        let it: RespItem;
        if (b.kind === 'text') {
          it = { type: 'message', id: rid('msg'), text: '' };
        } else {
          const custom = this.customTools.has(b.name ?? '');
          it = {
            type: custom ? 'custom_tool_call' : 'function_call',
            id: b.id
              ? `${custom ? 'ctc' : 'fc'}_${escapeCallId(b.id)}`
              : rid(custom ? 'ctc' : 'fc'),
            call_id: b.id ?? '',
            name: b.name ?? '',
            arguments: '',
          };
        }
        this.items.push(it);
        const idx = this.items.length - 1;
        this.itemIndex.set(b, idx);
        s += this.emit('response.output_item.added', {
          output_index: idx,
          item: this.itemJson(it, 'in_progress'),
        });
        if (it.type === 'message') {
          s += this.emit('response.content_part.added', {
            item_id: it.id,
            output_index: idx,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
        }
        return s;
      },
      delta: (b, d) => {
        const idx = this.itemIndex.get(b)!;
        const it = this.items[idx]!;
        if (it.type === 'message') {
          it.text += d;
          return this.emit('response.output_text.delta', {
            item_id: it.id,
            output_index: idx,
            content_index: 0,
            delta: d,
          });
        }
        it.arguments += d;
        // 自由文本工具的 JSON 片段无法逐段还原，收尾时一次性发出
        if (it.type === 'custom_tool_call') return '';
        return this.emit('response.function_call_arguments.delta', {
          item_id: it.id,
          output_index: idx,
          delta: d,
        });
      },
      close: (b) => this.closeItem(this.itemIndex.get(b)!),
    };
  }

  private emit(type: string, payload: Record<string, unknown>): string {
    return formatSse(type, { type, sequence_number: this.seq++, ...payload });
  }

  private snapshot(status: string, extra: Record<string, unknown> = {}) {
    return {
      id: this.id,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output:
        status === 'in_progress' ? [] : this.items.map((it) => this.itemJson(it, 'completed')),
      ...extra,
    };
  }

  private itemJson(it: RespItem, status: string): Record<string, unknown> {
    if (it.type === 'message') {
      return {
        type: 'message',
        id: it.id,
        status,
        role: 'assistant',
        content:
          status === 'in_progress' ? [] : [{ type: 'output_text', text: it.text, annotations: [] }],
      };
    }
    if (it.type === 'custom_tool_call') {
      return {
        type: 'custom_tool_call',
        id: it.id,
        call_id: it.call_id,
        name: it.name,
        input: status === 'in_progress' ? '' : customToolInput(it.arguments),
        status,
      };
    }
    return {
      type: 'function_call',
      id: it.id,
      call_id: it.call_id,
      name: it.name,
      arguments: status === 'in_progress' ? '' : it.arguments,
      status,
    };
  }

  private ensureStart(id?: string, model?: string, usage?: StreamUsage): string {
    if (this.started) return '';
    this.started = true;
    this.id = id && id.startsWith('resp_') ? id : rid('resp');
    if (model) this.model = model;
    if (usage) this.usage = { ...usage };
    return (
      this.emit('response.created', { response: this.snapshot('in_progress') }) +
      this.emit('response.in_progress', { response: this.snapshot('in_progress') })
    );
  }

  /** 关闭一个 output item：此时它的文本 / 参数已完整，done 事件里的内容与最终快照一致 */
  private closeItem(idx: number): string {
    const it = this.items[idx]!;
    let s = '';
    if (it.type === 'message') {
      s += this.emit('response.output_text.done', {
        item_id: it.id,
        output_index: idx,
        content_index: 0,
        text: it.text,
      });
      s += this.emit('response.content_part.done', {
        item_id: it.id,
        output_index: idx,
        content_index: 0,
        part: { type: 'output_text', text: it.text, annotations: [] },
      });
    } else if (it.type === 'custom_tool_call') {
      const input = customToolInput(it.arguments);
      if (input) {
        s += this.emit('response.custom_tool_call_input.delta', {
          item_id: it.id,
          output_index: idx,
          delta: input,
        });
      }
      s += this.emit('response.custom_tool_call_input.done', {
        item_id: it.id,
        output_index: idx,
        input,
      });
    } else {
      s += this.emit('response.function_call_arguments.done', {
        item_id: it.id,
        output_index: idx,
        arguments: it.arguments,
      });
    }
    s += this.emit('response.output_item.done', {
      output_index: idx,
      item: this.itemJson(it, 'completed'),
    });
    return s;
  }

  encode(ev: NormEvent): string {
    if (this.closed) return '';
    switch (ev.type) {
      case 'start':
        return this.ensureStart(ev.id, ev.model, ev.usage);
      case 'text':
        return this.ensureStart() + this.blocks.text(ev.text);
      case 'tool_start':
        return this.ensureStart() + this.blocks.toolStart(ev.key, ev.id, ev.name);
      case 'tool_args':
        return this.blocks.toolArgs(ev.key, ev.delta);
      case 'tool_end':
        return this.blocks.toolEnd(ev.key);
      case 'finish': {
        this.closed = true;
        const u = { ...this.usage, ...stripUndef(ev.usage) };
        const usage = {
          input_tokens: u.inputTokens ?? 0,
          output_tokens: u.outputTokens ?? 0,
          total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
        };
        let s = this.ensureStart() + this.blocks.finish();
        if (ev.reason === 'max_tokens') {
          s += this.emit('response.incomplete', {
            response: this.snapshot('incomplete', {
              incomplete_details: { reason: 'max_output_tokens' },
              usage,
            }),
          });
        } else {
          s += this.emit('response.completed', { response: this.snapshot('completed', { usage }) });
        }
        return s;
      }
      case 'error': {
        this.closed = true;
        return (
          this.ensureStart() +
          this.emit('response.failed', {
            response: this.snapshot('failed', {
              error: { code: ev.errorType ?? 'api_error', message: ev.message },
            }),
          })
        );
      }
      case 'alive':
        return HEARTBEAT_COMMENT;
      default:
        return '';
    }
  }

  end(): string {
    return '';
  }
}

/* ---------------------------- Chat Completions ---------------------------- */

function chatFinishReason(r: StopReason): string {
  switch (r) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

export class ChatCompletionsEncoder implements StreamEncoder {
  private started = false;
  private closed = false;
  private id = rid('chatcmpl');
  private model: string;
  private created = Math.floor(Date.now() / 1000);
  private toolIndex = new Map<string, number>();
  private usage: StreamUsage = {};

  constructor(fallbackModel = '') {
    this.model = fallbackModel;
  }

  private chunk(
    delta: Record<string, unknown>,
    finish: string | null = null,
    extra: Record<string, unknown> = {},
  ) {
    return formatSse(undefined, {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    });
  }

  private ensureStart(id?: string, model?: string, usage?: StreamUsage): string {
    if (this.started) return '';
    this.started = true;
    if (id) this.id = id;
    if (model) this.model = model;
    if (usage) this.usage = { ...usage };
    return this.chunk({ role: 'assistant', content: '' });
  }

  encode(ev: NormEvent): string {
    if (this.closed) return '';
    switch (ev.type) {
      case 'start':
        return this.ensureStart(ev.id, ev.model, ev.usage);
      case 'text':
        return this.ensureStart() + this.chunk({ content: ev.text });
      case 'tool_start': {
        const index = this.toolIndex.size;
        this.toolIndex.set(ev.key, index);
        return (
          this.ensureStart() +
          this.chunk({
            tool_calls: [
              { index, id: ev.id, type: 'function', function: { name: ev.name, arguments: '' } },
            ],
          })
        );
      }
      case 'tool_args': {
        const index = this.toolIndex.get(ev.key);
        if (index === undefined) return '';
        return this.chunk({ tool_calls: [{ index, function: { arguments: ev.delta } }] });
      }
      case 'finish': {
        this.closed = true;
        const u = { ...this.usage, ...stripUndef(ev.usage) };
        return (
          this.ensureStart() +
          this.chunk({}, chatFinishReason(ev.reason), {
            usage: {
              prompt_tokens: u.inputTokens ?? 0,
              completion_tokens: u.outputTokens ?? 0,
              total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            },
          }) +
          formatSse(undefined, '[DONE]')
        );
      }
      case 'error':
        this.closed = true;
        return (
          formatSse(undefined, {
            error: { message: ev.message, type: ev.errorType ?? 'api_error' },
          }) + formatSse(undefined, '[DONE]')
        );
      case 'alive':
        return HEARTBEAT_COMMENT;
      default:
        return '';
    }
  }

  end(): string {
    return '';
  }
}

/* --------------------------------- Gemini --------------------------------- */

function parseArgsObject(args: string): unknown {
  if (!args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _raw: args };
  }
}

/**
 * Gemini streamGenerateContent(alt=sse)：每个分片是一个完整的 GenerateContentResponse。
 * 工具调用在参数完整（tool_end 或 finish）后一次发出，推理文本作为 thought 部分发出。
 */
export class GeminiEncoder implements StreamEncoder {
  private closed = false;
  private id = rid('gemini');
  private model: string;
  private usage: StreamUsage = {};
  private readonly tools = new Map<string, { id: string; name: string; args: string }>();

  constructor(fallbackModel = '') {
    this.model = fallbackModel;
  }

  private chunk(
    parts: unknown[],
    extra: Record<string, unknown> = {},
    top: Record<string, unknown> = {},
  ) {
    return formatSse(undefined, {
      candidates: [{ content: { role: 'model', parts }, index: 0, ...extra }],
      modelVersion: this.model,
      responseId: this.id,
      ...top,
    });
  }

  private flushTool(key: string): string {
    const t = this.tools.get(key);
    if (!t) return '';
    this.tools.delete(key);
    return this.chunk([
      { functionCall: { id: t.id, name: t.name, args: parseArgsObject(t.args) } },
    ]);
  }

  encode(ev: NormEvent): string {
    if (this.closed) return '';
    switch (ev.type) {
      case 'start':
        if (ev.id) this.id = ev.id;
        if (ev.model) this.model = ev.model;
        if (ev.usage) this.usage = { ...ev.usage };
        return '';
      case 'text':
        return ev.text ? this.chunk([{ text: ev.text }]) : '';
      case 'think':
        return ev.text ? this.chunk([{ text: ev.text, thought: true }]) : '';
      case 'tool_start':
        this.tools.set(ev.key, { id: ev.id, name: ev.name, args: '' });
        return '';
      case 'tool_args': {
        const t = this.tools.get(ev.key);
        if (t) t.args += ev.delta;
        return '';
      }
      case 'tool_end':
        return this.flushTool(ev.key);
      case 'finish': {
        this.closed = true;
        let s = '';
        for (const key of [...this.tools.keys()]) s += this.flushTool(key);
        const u = { ...this.usage, ...stripUndef(ev.usage) };
        const input = u.inputTokens ?? 0;
        const output = u.outputTokens ?? 0;
        return (
          s +
          this.chunk(
            [],
            { finishReason: ev.reason === 'max_tokens' ? 'MAX_TOKENS' : 'STOP' },
            {
              usageMetadata: {
                promptTokenCount: input,
                candidatesTokenCount: output,
                totalTokenCount: input + output,
              },
            },
          )
        );
      }
      case 'error': {
        this.closed = true;
        const { code, status } = geminiErrorStatus(ev.errorType);
        return formatSse(undefined, {
          error: { code: ev.status ?? code, message: ev.message, status },
        });
      }
      case 'alive':
        return HEARTBEAT_COMMENT;
      default:
        return '';
    }
  }

  end(): string {
    return '';
  }
}
