import { describe, it, expect } from 'vitest';

import { jsonToJson } from '../src/stream';

const chatTool = {
  id: 'chatcmpl-1',
  model: 'gpt-x',
  choices: [
    {
      message: {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          },
          { id: 'call_2', type: 'function', function: { name: 'ls', arguments: '' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

const responsesTool = {
  id: 'resp_1',
  model: 'gpt-r',
  status: 'completed',
  output: [
    { type: 'reasoning', id: 'rs', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text: 'Running.' }] },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_9',
      name: 'shell',
      arguments: '{"cmd":"ls"}',
    },
  ],
  usage: { input_tokens: 4, output_tokens: 6 },
};

const geminiTool = {
  responseId: 'g1',
  modelVersion: 'gemini-x',
  candidates: [
    {
      content: {
        parts: [{ text: 'Let me grep.' }, { functionCall: { name: 'grep', args: { q: 'x' } } }],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
};

const messagesTool = {
  id: 'msg_1',
  type: 'message',
  model: 'claude-x',
  content: [
    { type: 'text', text: 'Editing.' },
    { type: 'tool_use', id: 'toolu_1', name: 'edit', input: { f: 1 } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 20, output_tokens: 15 },
};

describe('non-streaming → Anthropic Messages (Claude Code)', () => {
  it('chat completions tool calls, stop and usage', () => {
    const r = jsonToJson('chat', 'messages', chatTool);
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({
      id: 'chatcmpl-1',
      type: 'message',
      role: 'assistant',
      model: 'gpt-x',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'call_2', name: 'ls', input: {} },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });

  it('responses function_call', () => {
    const b = jsonToJson('responses', 'messages', responsesTool).body as any;
    expect(b.content).toEqual([
      { type: 'text', text: 'Running.' },
      { type: 'tool_use', id: 'call_9', name: 'shell', input: { cmd: 'ls' } },
    ]);
    expect(b.stop_reason).toBe('tool_use');
    expect(b.usage).toEqual({ input_tokens: 4, output_tokens: 6 });
  });

  it('gemini functionCall', () => {
    const b = jsonToJson('gemini', 'messages', geminiTool).body as any;
    expect(b.content[1]).toMatchObject({ type: 'tool_use', name: 'grep', input: { q: 'x' } });
    expect(b.stop_reason).toBe('tool_use');
    expect(b.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it('max tokens stop reasons', () => {
    const c = jsonToJson('chat', 'messages', {
      choices: [{ message: { content: 'x' }, finish_reason: 'length' }],
    });
    expect((c.body as any).stop_reason).toBe('max_tokens');
    const g = jsonToJson('gemini', 'messages', {
      candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }],
    });
    expect((g.body as any).stop_reason).toBe('max_tokens');
    const r = jsonToJson('responses', 'messages', {
      output: [],
      incomplete_details: { reason: 'max_output_tokens' },
    });
    expect((r.body as any).stop_reason).toBe('max_tokens');
  });

  it('upstream error body → Anthropic error with status', () => {
    const r = jsonToJson('chat', 'messages', {
      error: { message: 'slow down', type: 'rate_limit_error' },
    });
    expect(r).toEqual({
      ok: false,
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
    });
  });
});

describe('non-streaming → OpenAI Responses (Codex)', () => {
  it('chat completions tool calls → function_call items, usage', () => {
    const b = jsonToJson('chat', 'responses', chatTool).body as any;
    expect(b.object).toBe('response');
    expect(b.status).toBe('completed');
    expect(b.output.map((o: any) => o.type)).toEqual(['message', 'function_call', 'function_call']);
    expect(b.output[1]).toMatchObject({
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"a.ts"}',
    });
    expect(b.output[2].arguments).toBe('{}');
    expect(b.output_text).toBe('Checking.');
    expect(b.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it('anthropic messages tool_use → function_call; max_tokens → incomplete', () => {
    const b = jsonToJson('messages', 'responses', messagesTool).body as any;
    expect(b.output[1]).toMatchObject({
      type: 'function_call',
      call_id: 'toolu_1',
      name: 'edit',
      arguments: '{"f":1}',
    });
    const m = jsonToJson('messages', 'responses', { ...messagesTool, stop_reason: 'max_tokens' })
      .body as any;
    expect(m.status).toBe('incomplete');
    expect(m.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('anthropic error → OpenAI error body', () => {
    const r = jsonToJson('messages', 'responses', {
      type: 'error',
      error: { type: 'overloaded_error', message: 'busy' },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(529);
    expect(r.body).toEqual({
      error: { message: 'busy', type: 'overloaded_error', code: 'overloaded_error' },
    });
  });
});

describe('non-streaming → Chat Completions (Codex chat entry)', () => {
  it('anthropic messages tool_use → tool_calls with finish_reason', () => {
    const b = jsonToJson('messages', 'chat', messagesTool).body as any;
    expect(b.object).toBe('chat.completion');
    expect(b.choices[0]).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: 'Editing.',
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'edit', arguments: '{"f":1}' } },
        ],
      },
      finish_reason: 'tool_calls',
    });
    expect(b.usage).toEqual({ prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 });
  });

  it('text-only end_turn → stop with null tool_calls omitted', () => {
    const b = jsonToJson('messages', 'chat', {
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
    }).body as any;
    expect(b.choices[0].message).toEqual({ role: 'assistant', content: 'hi' });
    expect(b.choices[0].finish_reason).toBe('stop');
  });
});
