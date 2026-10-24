import { describe, it, expect } from 'vitest';

import {
  createStreamConverter,
  SseParser,
  type DownstreamStreamFormat,
  type UpstreamStreamFormat,
} from '../src/stream';

/** 把对象数组编成上游 SSE 文本 */
function sse(events: Array<[string | undefined, unknown]>, crlf = false): string {
  const nl = crlf ? '\r\n' : '\n';
  return events
    .map(
      ([e, d]) =>
        `${e ? `event: ${e}${nl}` : ''}data: ${typeof d === 'string' ? d : JSON.stringify(d)}${nl}${nl}`,
    )
    .join('');
}

/** 以很小的分片喂给转换器，模拟任意网络边界 */
function run(
  from: UpstreamStreamFormat,
  to: DownstreamStreamFormat,
  raw: string,
  size = 7,
): Array<{ event?: string; data: any }> {
  const c = createStreamConverter(from, to, { model: 'fallback-model' });
  let out = '';
  for (let i = 0; i < raw.length; i += size) out += c.push(raw.slice(i, i + size));
  out += c.end();
  const p = new SseParser();
  return [...p.push(out), ...p.end()].map((e) => ({
    event: e.event,
    data: e.data === '[DONE]' ? '[DONE]' : JSON.parse(e.data),
  }));
}

function types(evs: Array<{ event?: string; data: any }>): string[] {
  return evs.map((e) => e.event ?? (e.data === '[DONE]' ? '[DONE]' : 'chunk'));
}

/* ------------------------------ 录制样本 ------------------------------ */

const chatText = sse([
  [
    undefined,
    {
      id: 'chatcmpl-1',
      model: 'gpt-x',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' } }],
    },
  ],
  [
    undefined,
    { id: 'chatcmpl-1', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'Hel' } }] },
  ],
  [
    undefined,
    { id: 'chatcmpl-1', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'lo 世界' } }] },
  ],
  [
    undefined,
    { id: 'chatcmpl-1', model: 'gpt-x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ],
  [
    undefined,
    {
      id: 'chatcmpl-1',
      model: 'gpt-x',
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 4 },
    },
  ],
  [undefined, '[DONE]'],
]);

const chatTool = sse([
  [
    undefined,
    { id: 'c2', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'Let me check.' } }] },
  ],
  [
    undefined,
    {
      id: 'c2',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_a',
                type: 'function',
                function: { name: 'read_file', arguments: '' },
              },
            ],
          },
        },
      ],
    },
  ],
  [
    undefined,
    {
      id: 'c2',
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } },
      ],
    },
  ],
  [
    undefined,
    {
      id: 'c2',
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } },
      ],
    },
  ],
  [
    undefined,
    {
      id: 'c2',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 1, id: 'call_b', function: { name: 'ls', arguments: '{}' } }],
          },
        },
      ],
    },
  ],
  [undefined, { id: 'c2', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }],
  [undefined, '[DONE]'],
]);

const chatLength = sse([
  [
    undefined,
    { id: 'c3', choices: [{ index: 0, delta: { content: 'trunc' }, finish_reason: 'length' }] },
  ],
  [undefined, '[DONE]'],
]);

const chatError = sse([
  [undefined, { id: 'c4', choices: [{ index: 0, delta: { content: 'par' } }] }],
  [undefined, { error: { message: 'rate limited', type: 'rate_limit_error' } }],
]);

const respText = sse(
  [
    [
      'response.created',
      {
        type: 'response.created',
        response: { id: 'resp_1', model: 'gpt-r', status: 'in_progress' },
      },
    ],
    [
      'response.output_item.added',
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg_1' },
      },
    ],
    [
      'response.output_text.delta',
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'Hi ' },
    ],
    [
      'response.output_text.delta',
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'there' },
    ],
    [
      'response.completed',
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ],
  ],
  true,
);

const respTool = sse([
  ['response.created', { type: 'response.created', response: { id: 'resp_2', model: 'gpt-r' } }],
  [
    'response.reasoning_summary_text.delta',
    { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
  ],
  [
    'response.output_item.added',
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'shell', arguments: '' },
    },
  ],
  [
    'response.function_call_arguments.delta',
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_9',
      output_index: 1,
      delta: '{"cmd":',
    },
  ],
  [
    'response.function_call_arguments.delta',
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_9',
      output_index: 1,
      delta: '"ls"}',
    },
  ],
  [
    'response.completed',
    {
      type: 'response.completed',
      response: { id: 'resp_2', usage: { input_tokens: 3, output_tokens: 9 } },
    },
  ],
]);

const respIncomplete = sse([
  ['response.created', { type: 'response.created', response: { id: 'resp_3' } }],
  ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'abc' }],
  [
    'response.incomplete',
    {
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' } },
    },
  ],
]);

const respFailed = sse([
  ['response.created', { type: 'response.created', response: { id: 'resp_4' } }],
  [
    'response.failed',
    {
      type: 'response.failed',
      response: { status: 'failed', error: { code: 'server_error', message: 'boom' } },
    },
  ],
]);

const geminiText = sse([
  [
    undefined,
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'Bon' }] } }],
      modelVersion: 'gemini-2',
    },
  ],
  [
    undefined,
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'jour' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
    },
  ],
]);

const geminiTool = sse([
  [
    undefined,
    {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: 'hmm' },
              { functionCall: { name: 'grep', args: { q: 'x' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    },
  ],
]);

const geminiMax = sse([
  [
    undefined,
    { candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }] },
  ],
]);

const geminiError = sse([
  [undefined, { error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } }],
]);

const messagesTool = sse([
  [
    'message_start',
    {
      type: 'message_start',
      message: { id: 'msg_a', model: 'claude-x', usage: { input_tokens: 20, output_tokens: 1 } },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  ['ping', { type: 'ping' }],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'On it' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'edit', input: {} },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"f":' },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '1}' },
    },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  [
    'message_delta',
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
  ],
  ['message_stop', { type: 'message_stop' }],
]);

const messagesMax = sse([
  [
    'message_start',
    {
      type: 'message_start',
      message: { id: 'msg_b', model: 'claude-x', usage: { input_tokens: 2 } },
    },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
  ],
  [
    'message_delta',
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } },
  ],
  ['message_stop', { type: 'message_stop' }],
]);

const messagesError = sse([
  ['message_start', { type: 'message_start', message: { id: 'msg_c' } }],
  ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
]);

/* ------------------------------ 断言工具 ------------------------------ */

function messagesText(evs: Array<{ event?: string; data: any }>): string {
  return evs
    .filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('');
}

function messagesToolArgs(evs: Array<{ event?: string; data: any }>, index: number): string {
  return evs
    .filter(
      (e) =>
        e.event === 'content_block_delta' &&
        e.data.index === index &&
        e.data.delta.type === 'input_json_delta',
    )
    .map((e) => e.data.delta.partial_json)
    .join('');
}

/** Messages 流结构校验：start/stop 成对，索引递增 */
function assertMessagesWellFormed(evs: Array<{ event?: string; data: any }>) {
  expect(evs[0].event).toBe('message_start');
  const open = new Set<number>();
  let last = -1;
  for (const e of evs) {
    if (e.event === 'content_block_start') {
      expect(e.data.index).toBe(last + 1);
      last = e.data.index;
      open.add(e.data.index);
    }
    if (e.event === 'content_block_delta') expect(open.has(e.data.index)).toBe(true);
    if (e.event === 'content_block_stop') open.delete(e.data.index);
  }
  expect(open.size).toBe(0);
}

/** Responses 流：sequence_number 严格递增、type 与 event 一致 */
function assertResponsesWellFormed(evs: Array<{ event?: string; data: any }>) {
  evs.forEach((e, i) => {
    expect(e.data.type).toBe(e.event);
    expect(e.data.sequence_number).toBe(i);
  });
  expect(evs[0].event).toBe('response.created');
}

/* ------------------------- Claude Code ← 非原生 ------------------------- */

describe('stream → Anthropic Messages (Claude Code)', () => {
  it('chat completions text + usage + stop', () => {
    const evs = run('chat', 'messages', chatText);
    assertMessagesWellFormed(evs);
    expect(evs[0].data.message).toMatchObject({
      id: 'chatcmpl-1',
      model: 'gpt-x',
      role: 'assistant',
    });
    expect(messagesText(evs)).toBe('Hello 世界');
    const md = evs.find((e) => e.event === 'message_delta')!;
    expect(md.data.delta.stop_reason).toBe('end_turn');
    expect(md.data.usage).toEqual({ input_tokens: 11, output_tokens: 4 });
    expect(types(evs).slice(-1)).toEqual(['message_stop']);
  });

  it('chat completions tool calls → tool_use blocks', () => {
    const evs = run('chat', 'messages', chatTool, 3);
    assertMessagesWellFormed(evs);
    const starts = evs
      .filter((e) => e.event === 'content_block_start')
      .map((e) => e.data.content_block);
    expect(starts).toEqual([
      { type: 'text', text: '' },
      { type: 'tool_use', id: 'call_a', name: 'read_file', input: {} },
      { type: 'tool_use', id: 'call_b', name: 'ls', input: {} },
    ]);
    expect(JSON.parse(messagesToolArgs(evs, 1))).toEqual({ path: 'a.ts' });
    expect(messagesToolArgs(evs, 2)).toBe('{}');
    expect(evs.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');
  });

  it('chat completions length → max_tokens', () => {
    const evs = run('chat', 'messages', chatLength);
    expect(evs.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe('max_tokens');
  });

  it('chat completions error mid-stream → error event, no message_stop', () => {
    const evs = run('chat', 'messages', chatError);
    expect(messagesText(evs)).toBe('par');
    const last = evs[evs.length - 1];
    expect(last.event).toBe('error');
    expect(last.data.error).toEqual({ type: 'rate_limit_error', message: 'rate limited' });
    expect(types(evs)).not.toContain('message_stop');
  });

  it('responses text (CRLF framing)', () => {
    const evs = run('responses', 'messages', respText, 5);
    assertMessagesWellFormed(evs);
    expect(evs[0].data.message.model).toBe('gpt-r');
    expect(messagesText(evs)).toBe('Hi there');
    const md = evs.find((e) => e.event === 'message_delta')!;
    expect(md.data).toMatchObject({
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    });
  });

  it('responses function_call → tool_use, reasoning ignored', () => {
    const evs = run('responses', 'messages', respTool);
    assertMessagesWellFormed(evs);
    expect(messagesText(evs)).toBe('');
    const start = evs.find((e) => e.event === 'content_block_start')!;
    expect(start.data.content_block).toMatchObject({
      type: 'tool_use',
      id: 'call_9',
      name: 'shell',
    });
    expect(JSON.parse(messagesToolArgs(evs, 0))).toEqual({ cmd: 'ls' });
    expect(evs.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');
  });

  it('responses incomplete → max_tokens; failed → error', () => {
    const a = run('responses', 'messages', respIncomplete);
    expect(a.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe('max_tokens');
    const b = run('responses', 'messages', respFailed);
    expect(b[b.length - 1]).toMatchObject({ event: 'error', data: { error: { message: 'boom' } } });
  });

  it('gemini text, tool, max tokens, error', () => {
    const t = run('gemini', 'messages', geminiText);
    assertMessagesWellFormed(t);
    expect(messagesText(t)).toBe('Bonjour');
    expect(t.find((e) => e.event === 'message_delta')!.data).toMatchObject({
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    });

    const tool = run('gemini', 'messages', geminiTool);
    assertMessagesWellFormed(tool);
    expect(messagesText(tool)).toBe('');
    expect(tool.find((e) => e.event === 'content_block_start')!.data.content_block).toMatchObject({
      type: 'tool_use',
      name: 'grep',
    });
    expect(JSON.parse(messagesToolArgs(tool, 0))).toEqual({ q: 'x' });
    expect(tool.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');

    const max = run('gemini', 'messages', geminiMax);
    expect(max.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe('max_tokens');

    const err = run('gemini', 'messages', geminiError);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatchObject({ event: 'error', data: { error: { message: 'quota' } } });
  });
});

/* ---------------------------- Codex ← 非原生 ---------------------------- */

describe('stream → OpenAI Responses (Codex)', () => {
  it('chat completions text', () => {
    const evs = run('chat', 'responses', chatText);
    assertResponsesWellFormed(evs);
    expect(types(evs)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    const done = evs[evs.length - 1].data.response;
    expect(done.status).toBe('completed');
    expect(done.model).toBe('gpt-x');
    expect(done.output[0].content[0].text).toBe('Hello 世界');
    expect(done.usage).toEqual({ input_tokens: 11, output_tokens: 4, total_tokens: 15 });
  });

  it('chat completions tool calls → function_call items', () => {
    const evs = run('chat', 'responses', chatTool, 4);
    assertResponsesWellFormed(evs);
    const added = evs
      .filter((e) => e.event === 'response.output_item.added')
      .map((e) => e.data.item);
    expect(added.map((i) => i.type)).toEqual(['message', 'function_call', 'function_call']);
    expect(added[1]).toMatchObject({ call_id: 'call_a', name: 'read_file' });
    const doneItems = evs
      .filter((e) => e.event === 'response.output_item.done')
      .map((e) => e.data.item);
    expect(JSON.parse(doneItems[1].arguments)).toEqual({ path: 'a.ts' });
    const argsDone = evs.filter((e) => e.event === 'response.function_call_arguments.done');
    expect(argsDone.map((e) => e.data.arguments)).toEqual(['{"path":"a.ts"}', '{}']);
    expect(evs[evs.length - 1].data.response.output).toHaveLength(3);
  });

  it('chat completions length → response.incomplete', () => {
    const evs = run('chat', 'responses', chatLength);
    const last = evs[evs.length - 1];
    expect(last.event).toBe('response.incomplete');
    expect(last.data.response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('chat completions error → response.failed', () => {
    const evs = run('chat', 'responses', chatError);
    const last = evs[evs.length - 1];
    expect(last.event).toBe('response.failed');
    expect(last.data.response.error).toEqual({ code: 'rate_limit_error', message: 'rate limited' });
  });

  it('anthropic messages text + tool_use', () => {
    const evs = run('messages', 'responses', messagesTool, 6);
    assertResponsesWellFormed(evs);
    const done = evs[evs.length - 1];
    expect(done.event).toBe('response.completed');
    expect(done.data.response.output).toEqual([
      expect.objectContaining({
        type: 'message',
        content: [expect.objectContaining({ text: 'On it' })],
      }),
      expect.objectContaining({
        type: 'function_call',
        call_id: 'toolu_1',
        name: 'edit',
        arguments: '{"f":1}',
      }),
    ]);
    expect(done.data.response.usage).toEqual({
      input_tokens: 20,
      output_tokens: 15,
      total_tokens: 35,
    });
  });

  it('anthropic messages max_tokens and error', () => {
    const a = run('messages', 'responses', messagesMax);
    expect(a[a.length - 1].event).toBe('response.incomplete');
    const b = run('messages', 'responses', messagesError);
    expect(b[b.length - 1]).toMatchObject({
      event: 'response.failed',
      data: { response: { error: { code: 'overloaded_error', message: 'Overloaded' } } },
    });
  });
});

describe('stream → Chat Completions (Codex chat entry)', () => {
  it('anthropic messages → chat chunks with tool calls, usage and [DONE]', () => {
    const evs = run('messages', 'chat', messagesTool);
    expect(evs[evs.length - 1].data).toBe('[DONE]');
    const chunks = evs.filter((e) => e.data !== '[DONE]').map((e) => e.data);
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks.every((c) => c.object === 'chat.completion.chunk' && c.id === 'msg_a')).toBe(
      true,
    );
    const text = chunks.map((c) => c.choices[0].delta.content ?? '').join('');
    expect(text).toBe('On it');
    const calls = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
    expect(calls[0]).toEqual({
      index: 0,
      id: 'toolu_1',
      type: 'function',
      function: { name: 'edit', arguments: '' },
    });
    expect(calls.map((c) => c.function.arguments).join('')).toBe('{"f":1}');
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe('tool_calls');
    expect(last.usage).toEqual({ prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 });
  });

  it('anthropic messages max_tokens → length; error → error chunk', () => {
    const a = run('messages', 'chat', messagesMax).filter((e) => e.data !== '[DONE]');
    expect(a[a.length - 1].data.choices[0].finish_reason).toBe('length');
    const b = run('messages', 'chat', messagesError);
    expect(b.map((e) => e.data)).toContainEqual({
      error: { message: 'Overloaded', type: 'overloaded_error' },
    });
    expect(b[b.length - 1].data).toBe('[DONE]');
  });
});

describe('stream edge cases', () => {
  it('stream truncated without terminator → error, not a normal finish', () => {
    const raw = sse([[undefined, { id: 'x', choices: [{ index: 0, delta: { content: 'a' } }] }]]);
    const evs = run('chat', 'messages', raw);
    expect(types(evs)).not.toContain('message_stop');
    expect(types(evs).at(-1)).toBe('error');
  });

  it('finish_reason without [DONE] still finishes once', () => {
    const raw = sse([
      [undefined, { id: 'x', choices: [{ index: 0, delta: { content: 'a' } }] }],
      [undefined, { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
    ]);
    const evs = run('chat', 'messages', raw);
    expect(types(evs).filter((t) => t === 'message_stop')).toHaveLength(1);
  });

  it('last event without trailing blank line is parsed', () => {
    const raw = 'data: {"candidates":[{"content":{"parts":[{"text":"z"}]},"finishReason":"STOP"}]}';
    expect(messagesText(run('gemini', 'messages', raw))).toBe('z');
  });

  it('empty upstream stream → error', () => {
    const evs = run('responses', 'messages', '');
    expect(evs).toEqual([{ event: 'error', data: expect.objectContaining({ type: 'error' }) }]);
  });

  it('fail() mid-stream emits downstream error', () => {
    const c = createStreamConverter('chat', 'responses');
    c.push(chatText.slice(0, 150));
    const p = new SseParser();
    const evs = p.push(c.fail('socket hang up')).map((e) => JSON.parse(e.data));
    expect(evs[evs.length - 1]).toMatchObject({
      type: 'response.failed',
      response: { error: { message: 'socket hang up' } },
    });
  });

  it('events after finish are ignored', () => {
    const raw =
      chatText + sse([[undefined, { choices: [{ index: 0, delta: { content: 'late' } }] }]]);
    expect(messagesText(run('chat', 'messages', raw))).toBe('Hello 世界');
  });
});

/** Chat 并行 tool_calls：A/B 同块开始，参数按 index 交错到达 */
const chatInterleaved = sse([
  [undefined, { id: 'c1', model: 'm', choices: [{ index: 0, delta: { role: 'assistant' } }] }],
  [
    undefined,
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_a', function: { name: 'read', arguments: '' } },
              { index: 1, id: 'call_b', function: { name: 'write', arguments: '' } },
            ],
          },
        },
      ],
    },
  ],
  [
    undefined,
    {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } },
      ],
    },
  ],
  [
    undefined,
    {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"b":' } }] } },
      ],
    },
  ],
  [
    undefined,
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }],
    },
  ],
  [
    undefined,
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] } }],
    },
  ],
  [
    undefined,
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    },
  ],
  [undefined, '[DONE]'],
]);

describe('interleaved parallel tool calls (serial block scheduling)', () => {
  it('Chat → Messages: each tool_use block gets complete, un-interleaved args', () => {
    for (const size of [5, 4096]) {
      const evs = run('chat', 'messages', chatInterleaved, size);
      // 任何时刻最多一个 block 打开：start/stop 严格嵌套成对
      let open = -1;
      const argsByIndex = new Map<number, string>();
      const names = new Map<number, string>();
      for (const e of evs) {
        if (e.event === 'content_block_start') {
          expect(open).toBe(-1);
          open = e.data.index;
          if (e.data.content_block.type === 'tool_use') names.set(open, e.data.content_block.name);
        } else if (e.event === 'content_block_delta') {
          expect(e.data.index).toBe(open);
          if (e.data.delta.type === 'input_json_delta') {
            argsByIndex.set(open, (argsByIndex.get(open) ?? '') + e.data.delta.partial_json);
          }
        } else if (e.event === 'content_block_stop') {
          expect(e.data.index).toBe(open);
          open = -1;
        }
      }
      expect(open).toBe(-1);
      expect(names.get(0)).toBe('read');
      expect(names.get(1)).toBe('write');
      expect(argsByIndex.get(0)).toBe('{"a":1}');
      expect(argsByIndex.get(1)).toBe('{"b":2}');
      expect(evs.at(-1)?.event).toBe('message_stop');
    }
  });

  it('Chat → Responses: arguments.done / output_item.done carry the final arguments', () => {
    const evs = run('chat', 'responses', chatInterleaved, 9);
    const done = evs.filter((e) => e.data.type === 'response.function_call_arguments.done');
    expect(done.map((e) => e.data.arguments)).toEqual(['{"a":1}', '{"b":2}']);
    const itemDone = evs.filter((e) => e.data.type === 'response.output_item.done');
    expect(itemDone.map((e) => e.data.item.arguments)).toEqual(['{"a":1}', '{"b":2}']);
    // 增量只会落在当前打开的 item 上
    let open: string | null = null;
    for (const e of evs) {
      const t = e.data.type;
      if (t === 'response.output_item.added') {
        expect(open).toBeNull();
        open = e.data.item.id;
      } else if (t === 'response.function_call_arguments.delta') {
        expect(e.data.item_id).toBe(open);
      } else if (t === 'response.output_item.done') {
        expect(e.data.item.id).toBe(open);
        open = null;
      }
    }
    const completed = evs.at(-1)!.data.response.output;
    expect(completed.map((i: any) => i.arguments)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('Chat → Responses: interleaved custom tool still emits its full input once', () => {
    const c = createStreamConverter('chat', 'responses', {
      customTools: new Set(['write']),
    });
    const out = c.push(chatInterleaved) + c.end();
    const p = new SseParser();
    const evs = [...p.push(out), ...p.end()].map((e) => JSON.parse(e.data));
    const custom = evs.find((e) => e.type === 'response.custom_tool_call_input.done');
    expect(custom).toBeTruthy();
    const fn = evs.filter((e) => e.type === 'response.function_call_arguments.done');
    expect(fn.map((e) => e.arguments)).toEqual(['{"a":1}']);
  });

  it('Chat text interleaved with tools keeps blocks serial and complete', () => {
    const raw = sse([
      [undefined, { id: 'c2', model: 'm', choices: [{ index: 0, delta: { content: 'Hi ' } }] }],
      [
        undefined,
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read' } }] },
            },
          ],
        },
      ],
      [undefined, { choices: [{ index: 0, delta: { content: 'there' } }] }],
      [
        undefined,
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] },
            },
          ],
        },
      ],
      [undefined, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }],
      [undefined, '[DONE]'],
    ]);
    const evs = run('chat', 'messages', raw, 11);
    let open = -1;
    let text = '';
    let args = '';
    for (const e of evs) {
      if (e.event === 'content_block_start') {
        expect(open).toBe(-1);
        open = e.data.index;
      } else if (e.event === 'content_block_delta') {
        expect(e.data.index).toBe(open);
        text += e.data.delta.text ?? '';
        args += e.data.delta.partial_json ?? '';
      } else if (e.event === 'content_block_stop') {
        open = -1;
      }
    }
    expect(text).toBe('Hi there');
    expect(args).toBe('{"x":1}');
  });

  it('Messages → Responses: explicit content_block_stop closes the tool item', () => {
    const raw = sse([
      ['message_start', { type: 'message_start', message: { id: 'msg_1', model: 'm', usage: {} } }],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_a', name: 'read', input: {} },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tu_b', name: 'write', input: {} },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"b":2}' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      [
        'message_delta',
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]);
    const evs = run('messages', 'responses', raw, 13);
    const done = evs.filter((e) => e.data.type === 'response.function_call_arguments.done');
    expect(done.map((e) => e.data.arguments)).toEqual(['{"a":1}', '{"b":2}']);
  });
});
