/**
 * 非流式路径（docs/design/cli-plugin-architecture.md §6.11.1）：上游回 JSON 时也走协议桥，
 * 「要流式」合成的 SSE 必须通过入口协议的规范校验；同协议只做规范补全与 Chat 结构修复。
 */
import { describe, expect, it } from 'vitest';

import { bridgeJson, bridgeMode, type BridgePlan } from '../src/bridge';
import type { Wire } from '../src/ir';
import { validateSse } from '../src/spec/index';

const WIRES: Wire[] = ['responses', 'chat', 'messages', 'gemini'];

/** 每种上游协议一份「正文 + 工具调用」的非流式响应 */
const JSON_BODIES: Record<Wire, unknown> = {
  chat: {
    id: 'c1',
    model: 'm',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Reading.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  },
  responses: {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    model: 'm',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Reading.' }],
      },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"p":1}' },
    ],
    usage: { input_tokens: 3, output_tokens: 2 },
  },
  messages: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: [
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read', input: { p: 1 } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 3, output_tokens: 2 },
  },
  gemini: {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: 'Reading.' }, { functionCall: { name: 'read', args: { p: 1 } } }],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
  },
};

const plan = (from: Wire, to: Wire): BridgePlan => ({
  from,
  to,
  mode: bridgeMode(from, to),
  model: 'm',
  fixes: {},
});

const upOf = (from: Wire) => {
  const parsed = JSON_BODIES[from];
  return { status: 200, contentType: 'application/json', text: JSON.stringify(parsed), parsed };
};

describe('bridgeJson: client wants a stream, upstream answered JSON', () => {
  for (const from of WIRES)
    for (const to of WIRES)
      it(`${from} JSON → ${to} SSE passes the ${to} spec`, () => {
        const out = bridgeJson(plan(from, to), upOf(from), true);
        expect(out.kind).toBe('sse');
        if (out.kind === 'sse') expect(validateSse(to, out.body)).toEqual([]);
      });
});

describe('bridgeJson: non-stream', () => {
  it('same-wire Responses: missing required fields are completed', () => {
    const parsed = { output: [{ type: 'function_call', name: 'read', arguments: '{}', id: 'fc' }] };
    const out = bridgeJson(
      plan('responses', 'responses'),
      { status: 200, contentType: 'application/json', text: JSON.stringify(parsed), parsed },
      false,
    );
    expect(out.kind).toBe('raw');
    if (out.kind !== 'raw') return;
    const body = JSON.parse(out.body);
    expect(body).toMatchObject({ object: 'response', status: 'completed', model: 'm' });
    expect(body.output[0]).toMatchObject({ call_id: 'fc' });
  });

  it('same-wire Chat without fixes: the body is passed through byte-for-byte', () => {
    const text = '{"id":"c1",  "choices":[{"index":0,"message":{"content":"hi"}}]}';
    const out = bridgeJson(
      plan('chat', 'chat'),
      {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        text,
        parsed: JSON.parse(text),
      },
      false,
    );
    expect(out).toEqual({
      kind: 'raw',
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: text,
    });
  });

  it('non-JSON upstream bodies are returned as they are', () => {
    const out = bridgeJson(
      plan('chat', 'messages'),
      { status: 200, contentType: 'text/plain', text: 'oops', parsed: 'oops' },
      false,
    );
    expect(out).toMatchObject({ kind: 'raw', body: 'oops', contentType: 'text/plain' });
  });

  it('cross-wire JSON keeps text, tool calls and stop reason', () => {
    for (const from of WIRES) {
      const out = bridgeJson(plan(from, 'messages'), upOf(from), false);
      if (from === 'messages') continue;
      expect(out.kind, from).toBe('json');
      if (out.kind !== 'json') continue;
      const b = out.body as {
        content: Array<{ type: string; name?: string }>;
        stop_reason: string;
      };
      expect(
        b.content.map((c) => c.type),
        from,
      ).toEqual(['text', 'tool_use']);
      expect(b.content[1]!.name).toBe('read');
      expect(b.stop_reason).toBe('tool_use');
    }
  });
});
