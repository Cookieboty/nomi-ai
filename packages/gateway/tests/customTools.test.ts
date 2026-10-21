import { describe, it, expect } from 'vitest';

import { createStreamConverter, jsonToJson, jsonToSse, SseParser } from '../src/stream';

const custom = new Set(['apply_patch']);
const PATCH = '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch';

function parse(raw: string) {
  const p = new SseParser();
  return [...p.push(raw), ...p.end()].map((e) => ({
    event: e.event,
    data: JSON.parse(e.data) as any,
  }));
}

/** Anthropic 上游：先调自由文本工具（JSON 分片），再调普通函数 */
const messagesStream = [
  [
    'message_start',
    { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 1 } } },
  ],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_p', name: 'apply_patch', input: {} },
    },
  ],
  ...JSON.stringify({ input: PATCH })
    .match(/[\s\S]{1,6}/g)!
    .map((frag) => [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: frag },
      },
    ]),
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_s', name: 'shell', input: {} },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' },
    },
  ],
  [
    'message_delta',
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
  ],
  ['message_stop', { type: 'message_stop' }],
]
  .map(([e, d]) => `event: ${e as string}\ndata: ${JSON.stringify(d)}\n\n`)
  .join('');

describe('custom (free-text) tools → custom_tool_call', () => {
  it('streaming: emits custom_tool_call item with raw input, function tools unchanged', () => {
    const c = createStreamConverter('messages', 'responses', { customTools: custom });
    let out = '';
    for (let i = 0; i < messagesStream.length; i += 11)
      out += c.push(messagesStream.slice(i, i + 11));
    out += c.end();
    const evs = parse(out);
    evs.forEach((e, i) => expect(e.data.sequence_number).toBe(i));

    const added = evs
      .filter((e) => e.event === 'response.output_item.added')
      .map((e) => e.data.item);
    expect(added[0]).toMatchObject({
      type: 'custom_tool_call',
      call_id: 'toolu_p',
      name: 'apply_patch',
      input: '',
    });
    expect(added[1]).toMatchObject({ type: 'function_call', call_id: 'toolu_s', name: 'shell' });

    // 自由文本工具不发 function_call_arguments.* 事件
    const fnArgs = evs.filter((e) =>
      (e.event ?? '').startsWith('response.function_call_arguments'),
    );
    expect(fnArgs.every((e) => e.data.item_id === added[1].id)).toBe(true);

    const inputDone = evs.find((e) => e.event === 'response.custom_tool_call_input.done')!;
    expect(inputDone.data).toMatchObject({ item_id: added[0].id, output_index: 0, input: PATCH });
    expect(evs.find((e) => e.event === 'response.custom_tool_call_input.delta')!.data.delta).toBe(
      PATCH,
    );

    const done = evs.filter((e) => e.event === 'response.output_item.done').map((e) => e.data.item);
    expect(done[0]).toEqual({
      type: 'custom_tool_call',
      id: added[0].id,
      call_id: 'toolu_p',
      name: 'apply_patch',
      input: PATCH,
      status: 'completed',
    });
    expect(done[1]).toMatchObject({ type: 'function_call', arguments: '{"cmd":"ls"}' });

    const completed = evs[evs.length - 1].data.response;
    expect(completed.output.map((o: any) => o.type)).toEqual(['custom_tool_call', 'function_call']);
  });

  it('streaming from chat upstream', () => {
    const raw =
      `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_p', function: { name: 'apply_patch', arguments: '{"input":' } }] } }] })}\n\n` +
      `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(PATCH) + '}' } }] }, finish_reason: 'tool_calls' }] })}\n\n` +
      'data: [DONE]\n\n';
    const c = createStreamConverter('chat', 'responses', { customTools: custom });
    const evs = parse(c.push(raw) + c.end());
    const item = evs.find((e) => e.event === 'response.output_item.done')!.data.item;
    expect(item).toMatchObject({ type: 'custom_tool_call', call_id: 'call_p', input: PATCH });
  });

  it('without custom tool names, behaviour is unchanged (function_call)', () => {
    const c = createStreamConverter('messages', 'responses');
    const evs = parse(c.push(messagesStream) + c.end());
    const types = evs
      .filter((e) => e.event === 'response.output_item.done')
      .map((e) => e.data.item.type);
    expect(types).toEqual(['function_call', 'function_call']);
  });

  it('non-streaming: custom_tool_call in Responses output', () => {
    const r = jsonToJson(
      'messages',
      'responses',
      {
        id: 'msg',
        content: [
          { type: 'tool_use', id: 'toolu_p', name: 'apply_patch', input: { input: PATCH } },
          { type: 'tool_use', id: 'toolu_s', name: 'shell', input: { cmd: 'ls' } },
        ],
        stop_reason: 'tool_use',
      },
      { customTools: custom },
    );
    const out = (r.body as any).output;
    expect(out[0]).toMatchObject({
      type: 'custom_tool_call',
      call_id: 'toolu_p',
      name: 'apply_patch',
      input: PATCH,
    });
    expect(out[1]).toMatchObject({
      type: 'function_call',
      call_id: 'toolu_s',
      arguments: '{"cmd":"ls"}',
    });
  });

  it('JSON→SSE fallback also emits custom_tool_call', () => {
    const evs = parse(
      jsonToSse(
        'chat',
        'responses',
        {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call_p',
                    function: { name: 'apply_patch', arguments: JSON.stringify({ input: PATCH }) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        { customTools: custom },
      ),
    );
    expect(evs.find((e) => e.event === 'response.output_item.done')!.data.item).toMatchObject({
      type: 'custom_tool_call',
      input: PATCH,
    });
  });

  it('malformed arguments fall back to the raw string', () => {
    const r = jsonToJson(
      'chat',
      'responses',
      {
        choices: [
          {
            message: {
              tool_calls: [{ id: 'c', function: { name: 'apply_patch', arguments: 'raw patch' } }],
            },
          },
        ],
      },
      { customTools: custom },
    );
    expect((r.body as any).output[0].input).toBe('raw patch');
  });
});
