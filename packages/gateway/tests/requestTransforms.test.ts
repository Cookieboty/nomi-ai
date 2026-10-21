import { describe, it, expect } from 'vitest';

import {
  chatCompletionsToMessages,
  messagesToChatCompletions,
  messagesToGemini,
  messagesToResponses,
  responsesToChatCompletions,
  responsesToMessages,
} from '../src/transforms';

const PNG = 'iVBORw0KGgo=';
const schema = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
  $schema: 'http://json-schema.org/draft-07/schema#',
};

/** Claude Code 风格的多轮工具循环 */
const messagesLoop = {
  model: 'claude-x',
  system: [
    { type: 'text', text: 'You are a coding agent.' },
    { type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } },
  ],
  max_tokens: 2048,
  temperature: 0.2,
  stop_sequences: ['END'],
  stream: true,
  tools: [
    { name: 'read_file', description: 'Read a file', input_schema: schema },
    { name: 'ls', input_schema: { type: 'object', properties: {} } },
    { type: 'web_search_20250305', name: 'web_search' },
  ],
  tool_choice: { type: 'auto', disable_parallel_tool_use: true },
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in a.ts? See screenshot.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 's' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'toolu_2', name: 'ls', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const a = 1;' },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          is_error: true,
          content: [{ type: 'text', text: 'permission denied' }],
        },
        { type: 'text', text: 'continue' },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'a.ts exports a = 1.' }] },
    { role: 'user', content: 'thanks' },
  ],
};

/** Codex 风格的 Responses 多轮工具循环 */
const responsesLoop = {
  model: 'gpt-x',
  instructions: 'You are Codex.',
  stream: true,
  parallel_tool_calls: false,
  tool_choice: 'auto',
  max_output_tokens: 1000,
  tools: [
    {
      type: 'function',
      name: 'shell',
      description: 'Run a command',
      parameters: schema,
      strict: false,
    },
    {
      type: 'custom',
      name: 'apply_patch',
      description: 'Apply a patch',
      format: { type: 'grammar' },
    },
    { type: 'web_search' },
  ],
  input: [
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Sandbox: workspace-write' }],
    },
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'list files' },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${PNG}` },
      ],
    },
    { type: 'reasoning', id: 'rs_1', summary: [] },
    { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"path":"."}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'a.ts\nb.ts' },
    { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch' },
    { type: 'custom_tool_call_output', call_id: 'call_2', output: 'Done' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Patched.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'great' }] },
  ],
};

/** Chat Completions 多轮工具循环 */
const chatLoop = {
  model: 'gpt-x',
  stream: true,
  max_completion_tokens: 512,
  stop: 'STOP',
  tool_choice: { type: 'function', function: { name: 'shell' } },
  tools: [
    { type: 'function', function: { name: 'shell', description: 'Run', parameters: schema } },
  ],
  messages: [
    { role: 'system', content: 'sys A' },
    { role: 'developer', content: [{ type: 'text', text: 'sys B' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
      ],
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'shell', arguments: '{"path":"x"}' } },
        { id: 'call_b', type: 'function', function: { name: 'shell', arguments: '{"path":"y"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_a', content: 'out a' },
    { role: 'tool', tool_call_id: 'call_b', content: [{ type: 'text', text: 'out b' }] },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'ok' },
  ],
};

describe('Messages → Chat Completions (Claude Code → chat upstream)', () => {
  const out = messagesToChatCompletions(messagesLoop, 'gpt-up') as any;

  it('maps system, sampling and max tokens', () => {
    expect(out.model).toBe('gpt-up');
    expect(out.messages[0]).toEqual({
      role: 'system',
      content: 'You are a coding agent.\nBe brief.',
    });
    expect(out).toMatchObject({ max_tokens: 2048, temperature: 0.2, stop: ['END'], stream: true });
  });

  it('maps tools, tool_choice and parallel flag (server tools skipped)', () => {
    expect(out.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read_file', description: 'Read a file', parameters: schema },
      },
      {
        type: 'function',
        function: { name: 'ls', parameters: { type: 'object', properties: {} } },
      },
    ]);
    expect(out.tool_choice).toBe('auto');
    expect(out.parallel_tool_calls).toBe(false);
  });

  it('maps the multi-turn tool loop with images', () => {
    expect(out.messages.slice(1)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in a.ts? See screenshot.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
        ],
      },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          },
          { id: 'toolu_2', type: 'function', function: { name: 'ls', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'export const a = 1;' },
      { role: 'tool', tool_call_id: 'toolu_2', content: 'Error: permission denied' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'a.ts exports a = 1.' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('maps forced tool / any / none choices', () => {
    const f = (tool_choice: unknown) =>
      (messagesToChatCompletions({ ...messagesLoop, tool_choice }) as any).tool_choice;
    expect(f({ type: 'tool', name: 'ls' })).toEqual({ type: 'function', function: { name: 'ls' } });
    expect(f({ type: 'any' })).toBe('required');
    expect(f({ type: 'none' })).toBe('none');
  });
});

describe('Messages → Responses (Claude Code → responses upstream)', () => {
  const out = messagesToResponses(messagesLoop, 'gpt-up') as any;

  it('maps system to instructions and max tokens', () => {
    expect(out).toMatchObject({
      model: 'gpt-up',
      instructions: 'You are a coding agent.\nBe brief.',
      max_output_tokens: 2048,
      temperature: 0.2,
      stream: true,
      store: false,
    });
  });

  it('maps tools and choice', () => {
    expect(out.tools).toEqual([
      { type: 'function', name: 'read_file', description: 'Read a file', parameters: schema },
      { type: 'function', name: 'ls', parameters: { type: 'object', properties: {} } },
    ]);
    expect(out.tool_choice).toBe('auto');
    expect(out.parallel_tool_calls).toBe(false);
    expect(
      (messagesToResponses({ ...messagesLoop, tool_choice: { type: 'tool', name: 'ls' } }) as any)
        .tool_choice,
    ).toEqual({ type: 'function', name: 'ls' });
  });

  it('maps the multi-turn loop into function_call / function_call_output items', () => {
    expect(out.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is in a.ts? See screenshot.' },
          { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
        ],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
      {
        type: 'function_call',
        call_id: 'toolu_1',
        name: 'read_file',
        arguments: '{"path":"a.ts"}',
      },
      { type: 'function_call', call_id: 'toolu_2', name: 'ls', arguments: '{}' },
      { type: 'function_call_output', call_id: 'toolu_1', output: 'export const a = 1;' },
      { type: 'function_call_output', call_id: 'toolu_2', output: 'Error: permission denied' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'a.ts exports a = 1.' }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
    ]);
  });
});

describe('Messages → Gemini (Claude Code → gemini upstream)', () => {
  const out = messagesToGemini(messagesLoop, 'gemini-x') as any;

  it('has no model field; system and generation config mapped', () => {
    expect(out.model).toBeUndefined();
    expect(out.systemInstruction).toEqual({
      parts: [{ text: 'You are a coding agent.\nBe brief.' }],
    });
    expect(out.generationConfig).toEqual({
      maxOutputTokens: 2048,
      temperature: 0.2,
      stopSequences: ['END'],
    });
  });

  it('maps tools with full JSON schema and tool config', () => {
    expect(out.tools).toEqual([
      {
        functionDeclarations: [
          { name: 'read_file', description: 'Read a file', parametersJsonSchema: schema },
          { name: 'ls', parametersJsonSchema: { type: 'object', properties: {} } },
        ],
      },
    ]);
    expect(out.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    const forced = messagesToGemini({
      ...messagesLoop,
      tool_choice: { type: 'tool', name: 'ls' },
    }) as any;
    expect(forced.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['ls'] },
    });
  });

  it('maps the multi-turn loop: functionCall / functionResponse with resolved names', () => {
    expect(out.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'What is in a.ts? See screenshot.' },
          { inlineData: { mimeType: 'image/png', data: PNG } },
        ],
      },
      {
        role: 'model',
        parts: [
          { text: 'Reading.' },
          { functionCall: { name: 'read_file', args: { path: 'a.ts' } } },
          { functionCall: { name: 'ls', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'read_file', response: { content: 'export const a = 1;' } } },
          { functionResponse: { name: 'ls', response: { error: 'Error: permission denied' } } },
          { text: 'continue' },
        ],
      },
      { role: 'model', parts: [{ text: 'a.ts exports a = 1.' }] },
      { role: 'user', parts: [{ text: 'thanks' }] },
    ]);
  });
});

describe('Responses → Messages (Codex → anthropic upstream)', () => {
  const out = responsesToMessages(responsesLoop, 'claude-up') as any;

  it('maps instructions + developer to system, max tokens, tools, choice', () => {
    expect(out.system).toBe('You are Codex.\n\nSandbox: workspace-write');
    expect(out.max_tokens).toBe(1000);
    expect(out.tools).toEqual([
      { name: 'shell', description: 'Run a command', input_schema: schema },
      {
        name: 'apply_patch',
        description: 'Apply a patch',
        input_schema: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
      },
    ]);
    expect(out.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it('maps the tool loop into alternating tool_use / tool_result messages', () => {
    expect(out.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'list files' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'shell', input: { path: '.' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.ts\nb.ts' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'apply_patch',
            input: { input: '*** Begin Patch' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'Done' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Patched.' }] },
      { role: 'user', content: [{ type: 'text', text: 'great' }] },
    ]);
  });

  it('defaults max_tokens and accepts a plain string input', () => {
    const o = responsesToMessages({ input: 'hi' }) as any;
    expect(o.max_tokens).toBe(8192);
    expect(o.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('maps required / forced function choices', () => {
    expect(
      (
        responsesToMessages({
          ...responsesLoop,
          parallel_tool_calls: true,
          tool_choice: 'required',
        }) as any
      ).tool_choice,
    ).toEqual({
      type: 'any',
    });
    expect(
      (
        responsesToMessages({
          ...responsesLoop,
          parallel_tool_calls: true,
          tool_choice: { type: 'function', name: 'shell' },
        }) as any
      ).tool_choice,
    ).toEqual({ type: 'tool', name: 'shell' });
  });
});

describe('Responses → Chat Completions (Codex → chat upstream)', () => {
  const out = responsesToChatCompletions(responsesLoop, 'gpt-up') as any;

  it('maps instructions, max tokens, tools, choice', () => {
    expect(out.messages[0]).toEqual({
      role: 'system',
      content: 'You are Codex.\n\nSandbox: workspace-write',
    });
    expect(out.max_tokens).toBe(1000);
    expect(out.tools.map((t: any) => t.function.name)).toEqual(['shell', 'apply_patch']);
    expect(out.tool_choice).toBe('auto');
    expect(out.parallel_tool_calls).toBe(false);
  });

  it('maps the multi-turn tool loop', () => {
    expect(out.messages.slice(1)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'list files' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${PNG}` } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'shell', arguments: '{"path":"."}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'a.ts\nb.ts' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_2', content: 'Done' },
      { role: 'assistant', content: 'Patched.' },
      { role: 'user', content: 'great' },
    ]);
  });

  it('omits max_tokens when the client sent none', () => {
    expect((responsesToChatCompletions({ input: 'hi' }) as any).max_tokens).toBeUndefined();
  });
});

describe('Chat Completions → Messages (Codex chat entry → anthropic upstream)', () => {
  const out = chatCompletionsToMessages(chatLoop, 'claude-up') as any;

  it('maps system/developer, max_completion_tokens, stop, tools, forced choice', () => {
    expect(out.system).toBe('sys A\n\nsys B');
    expect(out).toMatchObject({
      max_tokens: 512,
      stop_sequences: ['STOP'],
      stream: true,
      model: 'claude-up',
    });
    expect(out.tools).toEqual([{ name: 'shell', description: 'Run', input_schema: schema }]);
    expect(out.tool_choice).toEqual({ type: 'tool', name: 'shell' });
  });

  it('maps parallel tool calls and merges consecutive tool results', () => {
    expect(out.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_a', name: 'shell', input: { path: 'x' } },
          { type: 'tool_use', id: 'call_b', name: 'shell', input: { path: 'y' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_a', content: 'out a' },
          { type: 'tool_result', tool_use_id: 'call_b', content: 'out b' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: [{ type: 'text', text: 'ok' }] },
    ]);
  });

  it('tolerates malformed tool arguments', () => {
    const o = chatCompletionsToMessages({
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{bad' } }],
        },
      ],
    }) as any;
    expect(o.messages[0].content[0].input).toEqual({ _raw: '{bad' });
  });
});
