/**
 * 工具调用 id（§6.9.7）：确定性派生、跨协议格式映射与回程还原；
 * 响应方向的结构修复只有一份实现（rules.ts），透传与转换给出同样的结果。
 */
import { describe, expect, it } from 'vitest';

import {
  CallIds,
  callIdForWire,
  callIdSeed,
  escapeCallId,
  unescapeCallId,
} from '../src/models/rules/response/callIds';
import { ResponseRules } from '../src/models/rules/response/rules';
import { decodeMessages } from '../src/request/decode';
import { decodeChat } from '../src/request/decode';
import { encodeChat, encodeMessages } from '../src/request/encode';
import { ChatStreamPatcher } from '../src/stream/chatPatch';
import { createDecoder } from '../src/stream/decoders';
import { createStreamConverter, jsonToJson } from '../src/stream/index';

const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

describe('call id formats', () => {
  it('escape is reversible and only touches ids Messages would reject', () => {
    expect(escapeCallId('toolu_01AbC-x')).toBe('toolu_01AbC-x');
    const odd = 'functions.bash:0';
    const esc = escapeCallId(odd);
    expect(esc).toMatch(/^nomi_[A-Za-z0-9_-]+$/);
    expect(unescapeCallId(esc)).toBe(odd);
    // 用户自己起的 nomi_ 前缀不会被误解码
    expect(unescapeCallId('nomi_hello')).toBe('nomi_hello');
    expect(unescapeCallId('call_1')).toBe('call_1');
  });

  it('per-wire request ids: Messages charset, Chat length, others untouched', () => {
    expect(callIdForWire('messages', 'a.b:c')).toBe(escapeCallId('a.b:c'));
    const long = 'x'.repeat(64);
    const chat = callIdForWire('chat', long);
    expect(chat.length).toBeLessThanOrEqual(40);
    expect(callIdForWire('chat', long)).toBe(chat);
    expect(callIdForWire('chat', 'call_short')).toBe('call_short');
    expect(callIdForWire('responses', 'a.b:c')).toBe('a.b:c');
  });

  it('seed follows the conversation history, not time', () => {
    const a = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    const b = { model: 'other', messages: [{ role: 'user', content: 'hi' }], stream: true };
    const c = { model: 'm', messages: [{ role: 'user', content: 'bye' }] };
    expect(callIdSeed(a)).toBe(callIdSeed(b));
    expect(callIdSeed(a)).not.toBe(callIdSeed(c));
    expect(new CallIds('s').next()).toBe('call_s_0');
  });
});

describe('cross-protocol id mapping round trip', () => {
  it('Chat upstream id with dots → Messages client → back to Chat as the original id', () => {
    const conv = createStreamConverter('chat', 'messages', { model: 'm' });
    const out =
      conv.push(
        sse({
          id: 'c1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'functions.bash:0',
                    type: 'function',
                    function: { name: 'bash', arguments: '{"cmd":"ls"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }) + sse({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      ) + conv.end();
    const m = /"tool_use","id":"([^"]+)"/.exec(out);
    expect(m).toBeTruthy();
    const clientId = m![1]!;
    expect(clientId).toMatch(/^[A-Za-z0-9_-]+$/);
    // 客户端下一轮带回历史：解码时还原，发给 Chat 上游的是原来的 id
    const ir = decodeMessages({
      model: 'x',
      max_tokens: 10,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: clientId, name: 'bash', input: { cmd: 'ls' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: clientId, content: 'ok' }],
        },
      ],
    });
    const body = encodeChat(ir, 'm') as { messages: Array<Record<string, unknown>> };
    const assistant = body.messages.find((x) => x.role === 'assistant')!;
    expect((assistant.tool_calls as Array<{ id: string }>)[0]!.id).toBe('functions.bash:0');
    expect(body.messages.find((x) => x.role === 'tool')!.tool_call_id).toBe('functions.bash:0');
  });

  it('history sent to a Messages upstream gets valid, consistent ids', () => {
    const ir = decodeChat({
      model: 'x',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'fn:1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'fn:1', content: 'ok' },
      ],
    });
    const body = JSON.stringify(encodeMessages(ir, 'claude'));
    const ids = [...body.matchAll(/"(?:id|tool_use_id)":"([^"]+)"/g)].map((x) => x[1]);
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('Gemini calls without ids get the same ids for the same history (seeded)', () => {
    const run = () => {
      const conv = createStreamConverter('gemini', 'messages', {
        model: 'm',
        fixes: { callIds: new CallIds(callIdSeed({ contents: [{ parts: [{ text: 'q' }] }] })) },
      });
      const chunk = sse({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] },
            finishReason: 'STOP',
          },
        ],
      });
      return conv.push(chunk) + conv.end();
    };
    const toolIds = (s: string) => [...s.matchAll(/"tool_use","id":"([^"]+)"/g)].map((m) => m[1]);
    const a = toolIds(run());
    expect(a).toEqual(toolIds(run()));
    expect(a).toEqual([expect.stringMatching(/^call_gemini_[0-9a-f]{12}_0$/)]);
  });

  it('non-stream Responses items get ids derived from call_id', () => {
    const r = jsonToJson('chat', 'responses', {
      id: 'c',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_9', type: 'function', function: { name: 'f', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const out = (r.body as { output: Array<{ id: string; call_id: string }> }).output;
    expect(out[0]).toMatchObject({ id: 'fc_call_9', call_id: 'call_9' });
  });
});

describe('decoders take canonical input', () => {
  it('Chat: missing index / object arguments / array content are normalized before decoding', () => {
    const dec = createDecoder('chat');
    const evs = [
      ...dec.push({
        data: JSON.stringify({
          choices: [
            {
              delta: {
                content: [{ type: 'text', text: 'hi' }],
                tool_calls: [
                  { id: 'a', function: { name: 'f', arguments: { x: 1 } } },
                  { id: 'b', function: { name: 'g', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      }),
      ...dec.push({ data: '[DONE]' }),
    ];
    expect(evs.filter((e) => e.type === 'tool_start').map((e) => (e as { id: string }).id)).toEqual(
      ['a', 'b'],
    );
    expect(evs).toContainEqual({ type: 'tool_args', key: '0', delta: '{"x":1}' });
    expect(evs).toContainEqual({ type: 'text', text: 'hi' });
  });

  it('Responses: keepalive dropped; whole items expanded once', () => {
    const dec = createDecoder('responses');
    const push = (o: unknown) => dec.push({ data: JSON.stringify(o) });
    const evs = [
      ...push({ type: 'response.created', response: { id: 'resp_1' } }),
      ...push({ type: 'response.output_text.delta', item_id: 'SSE-Keep-Alive', delta: ' ' }),
      ...push({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'whole' }] },
      }),
      ...push({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          output: [
            { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'whole' }] },
            { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'f', arguments: '{}' },
          ],
        },
      }),
    ];
    expect(evs.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'whole' }]);
    expect(evs.find((e) => e.type === 'tool_start')).toMatchObject({ id: 'c1', name: 'f' });
    expect(evs.some((e) => e.type === 'tool_end')).toBe(true);
    expect(evs.at(-1)).toMatchObject({ type: 'finish', reason: 'tool_use' });
  });
});

describe('one implementation of the structural fixes', () => {
  it('Chat passthrough and the NormEvent fixer convert text tool calls the same way', () => {
    const tools = new Set(['read']);
    const text = '<tool_call>{"name":"read","arguments":{"p":1}}</tool_call>';
    const notesA: string[] = [];
    const patch = new ChatStreamPatcher({
      textTools: tools,
      notes: notesA,
      callIds: new CallIds('s'),
    });
    const out =
      patch.push(
        sse({ id: 'c', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
      ) + patch.push(sse({ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    expect(out).toContain('"id":"call_s_0"');
    expect(out).toContain('"finish_reason":"tool_calls"');

    const notesB: string[] = [];
    const rules = new ResponseRules({ textTools: tools, notes: notesB, callIds: new CallIds('s') });
    rules.text(text);
    expect(rules.flush().calls).toEqual([{ id: 'call_s_0', name: 'read', args: '{"p":1}' }]);
    expect(notesB).toEqual(notesA);
  });
});
