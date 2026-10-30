/**
 * 上游给出没有工具名的工具调用：名字晚到的补上，始终没有名字的丢掉，四种协议都一样。
 * 原样转下去时客户端 SDK 整轮报错（AI SDK：Expected 'function.name' to be a string.）。
 */
import { describe, expect, it } from 'vitest';

import { createStreamConverter, jsonToJson, SseParser } from '../src/stream';
import { patchChatJson } from '../src/stream/chatPatch';
import { createPassthrough } from '../src/stream/passthrough';

type Obj = Record<string, any>;

const chat = (delta: Obj, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const tc = (index: number, fn: Obj, extra: Obj = {}) => ({ index, ...extra, function: fn });

/** 先给参数后给名字的 index 1、始终没有名字的 index 2、正常的 index 0 */
const mixed =
  chat({ role: 'assistant' }) +
  chat({ tool_calls: [tc(0, { name: 'f', arguments: '' }, { id: 'a', type: 'function' })] }) +
  chat({ tool_calls: [tc(1, { arguments: '{"y":' }), tc(2, { arguments: '{"lost":1}' })] }) +
  chat({ tool_calls: [tc(1, { name: 'h', arguments: '2}' }, { id: 'b', type: 'function' })] }) +
  chat({ tool_calls: [tc(0, { arguments: '{}' })] }) +
  chat({}, 'tool_calls') +
  'data: [DONE]\n\n';

const onlyNameless =
  chat({ role: 'assistant' }) +
  chat({ tool_calls: [tc(0, { arguments: '{"a":1}' })] }) +
  chat({}, 'tool_calls') +
  'data: [DONE]\n\n';

function events(out: string): Obj[] {
  const p = new SseParser();
  return [...p.push(out), ...p.end()]
    .filter((e) => e.data !== '[DONE]')
    .map((e) => JSON.parse(e.data) as Obj);
}

/** 下游 Chat 流 → 每个 index 的 { name, args } 与 finish_reason */
function chatCalls(out: string) {
  const calls = new Map<number, { name?: string; args: string }>();
  let finish: unknown = null;
  for (const e of events(out)) {
    const c = e.choices?.[0];
    if (!c) continue;
    if (c.finish_reason) finish = c.finish_reason;
    for (const t of c.delta?.tool_calls ?? []) {
      const cur = calls.get(t.index) ?? { args: '' };
      if (t.function?.name) cur.name = t.function.name;
      cur.args += t.function?.arguments ?? '';
      calls.set(t.index, cur);
    }
  }
  return { calls: [...calls.values()], finish };
}

describe('Chat 透传', () => {
  const run = (text: string) => {
    const p = createPassthrough('chat', { notes: [] })!;
    return p.push(text) + p.end();
  };

  it('名字晚到的补上参数，始终没有名字的丢掉', () => {
    const r = chatCalls(run(mixed));
    expect(r.calls).toEqual([
      { name: 'f', args: '{}' },
      { name: 'h', args: '{"y":2}' },
    ]);
    expect(r.finish).toBe('tool_calls');
  });

  it('一个调用都不剩时 finish_reason 改成 stop', () => {
    const r = chatCalls(run(onlyNameless));
    expect(r.calls).toEqual([]);
    expect(r.finish).toBe('stop');
  });

  it('非流式：丢掉没有名字的调用', () => {
    const body = {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'x', type: 'function', function: { arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const out = patchChatJson(body, {}) as Obj;
    expect(out.choices[0].message.tool_calls).toBeUndefined();
    expect(out.choices[0].finish_reason).toBe('stop');
  });
});

describe('协议转换', () => {
  const convert = (
    from: 'chat' | 'messages' | 'responses' | 'gemini',
    to: 'chat',
    text: string,
  ) => {
    const c = createStreamConverter(from, to);
    return c.push(text) + c.end();
  };

  it('Chat 上游：名字晚到的补上，始终没有名字的丢掉', () => {
    expect(chatCalls(convert('chat', 'chat', mixed)).calls).toEqual([
      { name: 'f', args: '{}' },
      { name: 'h', args: '{"y":2}' },
    ]);
    expect(chatCalls(convert('chat', 'chat', onlyNameless))).toEqual({ calls: [], finish: 'stop' });
  });

  it('Messages 上游：没有名字的 tool_use 丢掉', () => {
    const sse = (e: string, d: Obj) =>
      `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`;
    const text =
      sse('message_start', {
        message: { id: 'msg', model: 'claude', usage: { input_tokens: 1 } },
      }) +
      sse('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 't', input: {} },
      }) +
      sse('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
      }) +
      sse('content_block_stop', { index: 0 }) +
      sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }) +
      sse('message_stop', {});
    expect(chatCalls(convert('messages', 'chat', text))).toEqual({ calls: [], finish: 'stop' });
  });

  it('Gemini 上游：没有名字的 functionCall 丢掉，有名字的保留', () => {
    const text = `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { args: { a: 1 } } },
              { functionCall: { name: 'g', args: {} } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    })}\n\n`;
    const r = chatCalls(convert('gemini', 'chat', text));
    expect(r.calls).toEqual([{ name: 'g', args: '{}' }]);
  });

  it('Responses 非流式：没有名字的 function_call 丢掉', () => {
    const r = jsonToJson('responses', 'chat', {
      id: 'resp',
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'c', arguments: '{}' }],
    });
    const msg = (r.body as Obj).choices[0];
    expect(msg.message.tool_calls).toBeUndefined();
    expect(msg.finish_reason).toBe('stop');
  });
});
