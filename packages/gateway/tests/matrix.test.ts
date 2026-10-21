/**
 * 4×4 协议矩阵（docs/design/unified-gateway.md §17）：
 * - 请求：同一段对话从每种入口协议转到另外三种上游协议，再用目标协议的解码器读回，核对语义不丢；
 * - 流式：四种上游 SSE 转成四种入口 SSE，再用入口协议的解码器读回，核对文本、工具调用、停止原因、用量；
 * - 非流式：四种上游 JSON 转成四种入口 JSON，读回核对。
 */
import { describe, expect, it } from 'vitest';

import { WIRES, type IRRequest, type Wire } from '../src/ir';
import { convertRequest, decodeRequest, encodeRequest } from '../src/request';
import {
  createStreamConverter,
  jsonToEvents,
  jsonToJson,
  SseParser,
  type NormEvent,
} from '../src/stream';
import {
  ChatCompletionsDecoder,
  GeminiDecoder,
  MessagesDecoder,
  ResponsesDecoder,
} from '../src/stream/decoders';

/* ------------------------------ 请求矩阵 ------------------------------ */

/** 规范对话：先编码成各入口协议的请求体，作为矩阵的输入 */
const canonical: IRRequest = {
  model: 'client-model',
  system: [{ kind: 'text', text: 'You are terse.' }],
  messages: [
    {
      role: 'user',
      parts: [
        { kind: 'text', text: 'What is in this image?' },
        { kind: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
      ],
    },
    {
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'Let me check.' },
        { kind: 'tool_call', id: 'call_1', name: 'read_file', args: '{"path":"a.txt"}' },
      ],
    },
    { role: 'user', parts: [{ kind: 'tool_result', callId: 'call_1', text: 'file body' }] },
    { role: 'user', parts: [{ kind: 'text', text: 'Summarize.' }] },
  ],
  tools: [
    {
      name: 'read_file',
      description: 'Read a file',
      schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      kind: 'function',
    },
  ],
  toolChoice: 'auto',
  maxTokens: 512,
  temperature: 0.3,
  stream: true,
};

function ingressBody(wire: Wire): unknown {
  return encodeRequest(wire, canonical, canonical.model);
}

const texts = (ir: IRRequest) =>
  ir.messages.flatMap((m) => m.parts.filter((p) => p.kind === 'text').map((p) => p.text));

describe('request matrix: every ingress → every other upstream keeps the conversation', () => {
  for (const from of WIRES) {
    for (const to of WIRES) {
      if (from === to) continue; // 同协议不经过 IR（§9.2）
      it(`${from} → ${to}`, () => {
        const out = convertRequest(from, to, ingressBody(from), {
          model: canonical.model,
          stream: true,
          upstreamModel: 'up-model',
        });
        const back = decodeRequest(to, out, { model: 'up-model', stream: true });
        if (to !== 'gemini') expect(back.model).toBe('up-model');
        expect(back.system.map((p) => p.text).join('\n')).toContain('You are terse.');
        expect(texts(back)).toEqual(
          expect.arrayContaining(['What is in this image?', 'Let me check.', 'Summarize.']),
        );
        const parts = back.messages.flatMap((m) => m.parts);
        const call = parts.find((p) => p.kind === 'tool_call')!;
        expect(call.name).toBe('read_file');
        expect(JSON.parse(call.args!)).toEqual({ path: 'a.txt' });
        const result = parts.find((p) => p.kind === 'tool_result')!;
        expect(result.text).toBe('file body');
        // Gemini 请求里的工具调用没有 id（按工具名关联），经过 Gemini 后 id 是解码时生成的；
        // 不管经过哪种协议，结果都要对上它前面那次调用
        expect(result.callId).toBe(call.id);
        if (from !== 'gemini' && to !== 'gemini') expect(call.id).toBe('call_1');
        expect(parts.some((p) => p.kind === 'image' && p.data === 'iVBORw0KGgo=')).toBe(true);
        expect(back.tools.map((t) => t.name)).toEqual(['read_file']);
        expect(back.tools[0]!.schema).toEqual(canonical.tools[0]!.schema);
        expect(back.maxTokens).toBe(512);
        expect(back.temperature).toBe(0.3);
        // 工具结果紧跟在工具调用之后的那一轮 user 消息里
        const callIdx = back.messages.findIndex((m) => m.parts.some((p) => p.kind === 'tool_call'));
        expect(back.messages[callIdx + 1]!.parts[0]!.kind).toBe('tool_result');
      });
    }
  }
});

/* ------------------------------ 流式矩阵 ------------------------------ */

const sse = (evs: Array<[string | undefined, unknown]>) =>
  evs
    .map(
      ([e, d]) =>
        `${e ? `event: ${e}\n` : ''}data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`,
    )
    .join('');

/** 每种上游一段：一句正文 + 一次工具调用 f({"a":1})，用量 10 / 5 */
const upstreamSse: Record<Wire, string> = {
  chat: sse([
    [undefined, { id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'Hello' } }] }],
    [
      undefined,
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_f', function: { name: 'f', arguments: '{"a":' } }],
            },
          },
        ],
      },
    ],
    [
      undefined,
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } },
        ],
      },
    ],
    [
      undefined,
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ],
    [undefined, '[DONE]'],
  ]),
  responses: sse([
    ['response.created', { type: 'response.created', response: { id: 'resp_1', model: 'm' } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'Hello' }],
    [
      'response.output_item.added',
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_f', name: 'f', arguments: '' },
      },
    ],
    [
      'response.function_call_arguments.delta',
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"a":1}' },
    ],
    [
      'response.output_item.done',
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1' },
      },
    ],
    [
      'response.completed',
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ],
  ]),
  gemini: sse([
    [
      undefined,
      {
        responseId: 'g1',
        modelVersion: 'm',
        candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
      },
    ],
    [
      undefined,
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { id: 'call_f', name: 'f', args: { a: 1 } } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    ],
  ]),
  messages: sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: { id: 'msg_1', model: 'm', usage: { input_tokens: 10, output_tokens: 1 } },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'call_f', name: 'f', input: {} },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]),
};

const decoderFor = (w: Wire) =>
  ({
    chat: () => new ChatCompletionsDecoder(),
    responses: () => new ResponsesDecoder(),
    gemini: () => new GeminiDecoder(),
    messages: () => new MessagesDecoder(),
  })[w]();

/** 用入口协议自己的解码器读回编码结果 */
function readBack(wire: Wire, text: string): NormEvent[] {
  const parser = new SseParser();
  const dec = decoderFor(wire);
  const out: NormEvent[] = [];
  for (const ev of [...parser.push(text), ...parser.end()]) out.push(...dec.push(ev));
  out.push(...dec.end());
  return out;
}

function summarize(evs: NormEvent[]) {
  const text = evs.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
  const tools = new Map<string, { name: string; args: string }>();
  for (const e of evs) {
    if (e.type === 'tool_start') tools.set(e.key, { name: e.name, args: '' });
    if (e.type === 'tool_args') tools.get(e.key)!.args += e.delta;
  }
  const finish = evs.find((e) => e.type === 'finish') as Extract<NormEvent, { type: 'finish' }>;
  return {
    text,
    tools: [...tools.values()].map((t) => ({ name: t.name, args: JSON.parse(t.args || '{}') })),
    reason: finish?.reason,
    usage: { in: finish?.usage?.inputTokens, out: finish?.usage?.outputTokens },
    errors: evs.filter((e) => e.type === 'error'),
  };
}

const want = {
  text: 'Hello',
  tools: [{ name: 'f', args: { a: 1 } }],
  reason: 'tool_use',
  usage: { in: 10, out: 5 },
  errors: [],
};

describe('stream matrix: every upstream → every ingress', () => {
  for (const from of WIRES) {
    for (const to of WIRES) {
      for (const chunk of [3, 1 << 20]) {
        it(`${from} → ${to} (chunk ${chunk})`, () => {
          const conv = createStreamConverter(from, to, { model: 'm' });
          const src = upstreamSse[from];
          let out = '';
          for (let i = 0; i < src.length; i += chunk) out += conv.push(src.slice(i, i + chunk));
          out += conv.end();
          expect(summarize(readBack(to, out))).toEqual(want);
        });
      }
    }
  }

  it('an upstream failure mid-stream becomes an error the ingress decoder recognizes', () => {
    for (const to of WIRES) {
      const conv = createStreamConverter('chat', to, { model: 'm' });
      const out =
        conv.push(sse([[undefined, { choices: [{ index: 0, delta: { content: 'Hi' } }] }]])) +
        conv.fail('connection reset');
      expect(summarize(readBack(to, out)).errors).toHaveLength(1);
    }
  });
});

/* ------------------------------ 非流式矩阵 ------------------------------ */

const upstreamJson: Record<Wire, unknown> = {
  chat: {
    id: 'c',
    model: 'm',
    choices: [
      {
        message: {
          content: 'Hello',
          tool_calls: [
            { id: 'call_f', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
  responses: {
    id: 'resp_1',
    model: 'm',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
      { type: 'function_call', id: 'fc', call_id: 'call_f', name: 'f', arguments: '{"a":1}' },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
  gemini: {
    candidates: [
      {
        content: { parts: [{ text: 'Hello' }, { functionCall: { name: 'f', args: { a: 1 } } }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  },
  messages: {
    id: 'msg',
    model: 'm',
    content: [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'call_f', name: 'f', input: { a: 1 } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  },
};

describe('json matrix: every upstream JSON → every ingress JSON', () => {
  for (const from of WIRES) {
    for (const to of WIRES) {
      it(`${from} → ${to}`, () => {
        const r = jsonToJson(from, to, upstreamJson[from], { model: 'm' });
        expect(r.ok).toBe(true);
        expect(summarize(jsonToEvents(to, r.body))).toEqual(want);
      });
    }
  }
});
