/**
 * 中间事件 → 下游 CLI 期望的非流式 JSON 响应（保留工具调用、停止原因与用量）。
 */
import type { NormEvent, StopReason, StreamUsage } from './events';

import type { DownstreamStreamFormat } from './index';

function rid(prefix: string): string {
  return `${prefix}_nomi_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

type Block =
  { kind: 'text'; text: string } | { kind: 'tool'; id: string; name: string; args: string };

/** 自由文本工具：模型按 {"input": "..."} 调用，还原为原始字符串 */
export function customToolInput(args: string): string {
  try {
    const v: unknown = JSON.parse(args);
    if (v && typeof v === 'object' && typeof (v as { input?: unknown }).input === 'string') {
      return (v as { input: string }).input;
    }
    return typeof v === 'string' ? v : args;
  } catch {
    return args;
  }
}

function parseInput(args: string): unknown {
  if (!args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _raw: args };
  }
}

export interface AggregateResult {
  /** 上游报错时为 false，body 为目标协议的错误体 */
  ok: boolean;
  status: number;
  body: unknown;
}

export function eventsToJson(
  to: DownstreamStreamFormat,
  events: NormEvent[],
  opts: { model?: string; customTools?: ReadonlySet<string> } = {},
): AggregateResult {
  let id: string | undefined;
  let model = opts.model ?? '';
  let usage: StreamUsage = {};
  let reason: StopReason = 'end_turn';
  const blocks: Block[] = [];
  const tools = new Map<string, Extract<Block, { kind: 'tool' }>>();
  for (const ev of events) {
    switch (ev.type) {
      case 'start':
        id = ev.id ?? id;
        if (ev.model) model = ev.model;
        if (ev.usage) usage = { ...usage, ...strip(ev.usage) };
        break;
      case 'text': {
        const last = blocks[blocks.length - 1];
        if (last?.kind === 'text') last.text += ev.text;
        else blocks.push({ kind: 'text', text: ev.text });
        break;
      }
      case 'tool_start': {
        const b: Block = { kind: 'tool', id: ev.id, name: ev.name, args: '' };
        tools.set(ev.key, b);
        blocks.push(b);
        break;
      }
      case 'tool_args': {
        const b = tools.get(ev.key);
        if (b) b.args += ev.delta;
        break;
      }
      case 'finish':
        reason = ev.reason;
        if (ev.usage) usage = { ...usage, ...strip(ev.usage) };
        break;
      case 'error':
        return errorBody(to, ev.message, ev.errorType);
      default:
        break;
    }
  }
  const inTok = usage.inputTokens ?? 0;
  const outTok = usage.outputTokens ?? 0;
  const text = blocks
    .filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('');

  if (to === 'messages') {
    return {
      ok: true,
      status: 200,
      body: {
        id: id || rid('msg'),
        type: 'message',
        role: 'assistant',
        model,
        content: blocks.map((b) =>
          b.kind === 'text'
            ? { type: 'text', text: b.text }
            : { type: 'tool_use', id: b.id, name: b.name, input: parseInput(b.args) },
        ),
        stop_reason: reason,
        stop_sequence: null,
        usage: { input_tokens: inTok, output_tokens: outTok },
      },
    };
  }

  if (to === 'chat') {
    const toolCalls = blocks
      .filter((b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool')
      .map((b) => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: b.args || '{}' },
      }));
    return {
      ok: true,
      status: 200,
      body: {
        id: id || rid('chatcmpl'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text || null,
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            },
            finish_reason:
              reason === 'max_tokens' ? 'length' : reason === 'tool_use' ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
      },
    };
  }

  // responses
  const output = blocks.map((b) => {
    if (b.kind === 'text') {
      return {
        type: 'message',
        id: rid('msg'),
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: b.text, annotations: [] }],
      };
    }
    if (opts.customTools?.has(b.name)) {
      return {
        type: 'custom_tool_call',
        id: rid('ctc'),
        call_id: b.id,
        name: b.name,
        input: customToolInput(b.args),
        status: 'completed',
      };
    }
    return {
      type: 'function_call',
      id: rid('fc'),
      call_id: b.id,
      name: b.name,
      arguments: b.args || '{}',
      status: 'completed',
    };
  });
  const incomplete = reason === 'max_tokens';
  return {
    ok: true,
    status: 200,
    body: {
      id: id && id.startsWith('resp_') ? id : rid('resp'),
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: incomplete ? 'incomplete' : 'completed',
      ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      model,
      output,
      output_text: text,
      usage: { input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok },
    },
  };
}

function strip(u: StreamUsage): StreamUsage {
  const o: StreamUsage = {};
  if (u.inputTokens !== undefined) o.inputTokens = u.inputTokens;
  if (u.outputTokens !== undefined) o.outputTokens = u.outputTokens;
  return o;
}

function errorBody(
  to: DownstreamStreamFormat,
  message: string,
  errorType?: string,
): AggregateResult {
  const status =
    errorType === 'rate_limit_error' ? 429 : errorType === 'overloaded_error' ? 529 : 502;
  if (to === 'messages') {
    return {
      ok: false,
      status,
      body: { type: 'error', error: { type: errorType || 'api_error', message } },
    };
  }
  return {
    ok: false,
    status,
    body: { error: { message, type: errorType || 'api_error', code: errorType || 'api_error' } },
  };
}
