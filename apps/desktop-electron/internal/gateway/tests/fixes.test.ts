/**
 * 网关侧的请求修正（§12.7.3）：作用在真正发给上游的请求体上。
 */
import { describe, expect, it } from 'vitest';

import type { RuntimeModel, RuntimeProvider } from '../src/config';
import {
  applyRequestFixes,
  cleanToolSchema,
  filterAnthropicBeta,
  IMAGE_OMITTED_TEXT,
  serverToolError,
  toolLimitError,
} from '../src/fixes';
import type { Wire } from '../src/ir';
import type { Candidate } from '../src/route/resolve';
import { upstreamBody, upstreamHeaders } from '../src/upstream';

const PNG = 'iVBORw0KGgo=';

function cand(
  wire: Wire,
  model: Partial<RuntimeModel> = {},
  extra: Partial<RuntimeProvider> = {},
): Candidate {
  const provider: RuntimeProvider = {
    id: 'ds',
    name: 'DeepSeek',
    enabled: true,
    urls: {
      messages: 'https://api.deepseek.com/anthropic',
      chat: 'https://api.deepseek.com/v1',
      responses: 'https://api.deepseek.com/v1',
      gemini: 'https://gemini.example.com/v1beta',
    },
    keys: [{ id: 'k1', value: 'sk', enabled: true }],
    models: [{ id: 'deepseek-v4-pro', enabled: true, ...model }],
    ...extra,
  };
  return {
    provider,
    key: provider.keys[0]!,
    publicModel: 'ds/deepseek-v4-pro',
    upstreamModel: 'deepseek-v4-pro',
    wire,
  };
}

const anthropicOfficial = { urls: { messages: 'https://api.anthropic.com' } };
type J = Record<string, any>;

describe('output cap', () => {
  it('clamps every max-tokens field to the model maxOutput', () => {
    const c = cand('chat', { maxOutput: 8192 });
    const out = applyRequestFixes(c, { max_tokens: 32000, max_completion_tokens: 64000 }) as J;
    expect(out).toMatchObject({ max_tokens: 8192, max_completion_tokens: 8192 });
    const r = applyRequestFixes(cand('responses', { maxOutput: 8192 }), {
      max_output_tokens: 9000,
    }) as J;
    expect(r.max_output_tokens).toBe(8192);
    const g = applyRequestFixes(cand('gemini', { maxOutput: 8192 }), {
      generationConfig: { maxOutputTokens: 65536, temperature: 1 },
    }) as J;
    expect(g.generationConfig).toEqual({ maxOutputTokens: 8192, temperature: 1 });
  });

  it('leaves values alone when below the cap or when metadata is missing', () => {
    expect(applyRequestFixes(cand('chat', { maxOutput: 8192 }), { max_tokens: 4096 })).toEqual({
      max_tokens: 4096,
    });
    expect(applyRequestFixes(cand('chat'), { max_tokens: 128000 })).toEqual({ max_tokens: 128000 });
  });

  it('does not mutate the input and reports notes', () => {
    const body = { max_tokens: 32000 };
    const notes: string[] = [];
    applyRequestFixes(cand('messages', { maxOutput: 8192 }), body, notes);
    expect(body.max_tokens).toBe(32000);
    expect(notes).toEqual(['max_tokens 32000 → 8192']);
  });
});

describe('thinking budget and reasoning', () => {
  it('lowers budget_tokens below the clamped max_tokens', () => {
    const out = applyRequestFixes(cand('messages', { maxOutput: 8192 }), {
      max_tokens: 32000,
      thinking: { type: 'enabled', budget_tokens: 31999 },
    }) as J;
    expect(out.max_tokens).toBe(8192);
    expect(out.thinking.budget_tokens).toBeLessThan(8192);
    expect(out.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
    expect(out.thinking.type).toBe('enabled');
  });

  it('drops thinking when the minimum budget cannot fit', () => {
    const out = applyRequestFixes(cand('messages', { maxOutput: 1100 }), {
      max_tokens: 32000,
      thinking: { type: 'enabled', budget_tokens: 16000 },
    }) as J;
    expect(out.max_tokens).toBe(1100);
    expect(out.thinking).toBeUndefined();
  });

  it('keeps a budget that already fits', () => {
    const out = applyRequestFixes(cand('messages', { maxOutput: 64000 }), {
      max_tokens: 32000,
      thinking: { type: 'enabled', budget_tokens: 10000 },
    }) as J;
    expect(out.thinking.budget_tokens).toBe(10000);
  });

  it('removes reasoning parameters for non-reasoning models', () => {
    const m = applyRequestFixes(cand('messages', { reasoning: false }), {
      max_tokens: 100,
      thinking: { type: 'enabled', budget_tokens: 50 },
    }) as J;
    expect('thinking' in m).toBe(false);
    const c = applyRequestFixes(cand('chat', { reasoning: false }), {
      reasoning_effort: 'high',
    }) as J;
    expect('reasoning_effort' in c).toBe(false);
    const r = applyRequestFixes(cand('responses', { reasoning: false }), {
      reasoning: { effort: 'medium' },
    }) as J;
    expect('reasoning' in r).toBe(false);
    const g = applyRequestFixes(cand('gemini', { reasoning: false }), {
      generationConfig: { thinkingConfig: { thinkingBudget: 100 }, temperature: 1 },
    }) as J;
    expect(g.generationConfig).toEqual({ temperature: 1 });
    // 推理模型或元数据缺失：保留
    expect(applyRequestFixes(cand('chat'), { reasoning_effort: 'high' })).toEqual({
      reasoning_effort: 'high',
    });
  });
});

describe('images on non-vision models', () => {
  const text = (t: string) => ({ type: 'text', text: t });

  it('Messages: image blocks, including inside tool_result, become a text line', () => {
    const notes: string[] = [];
    const out = applyRequestFixes(
      cand('messages', { vision: false }),
      {
        messages: [
          {
            role: 'user',
            content: [
              text('look'),
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
            ],
          },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shot', input: {} }] },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }],
              },
            ],
          },
        ],
      },
      notes,
    ) as J;
    expect(out.messages[0].content).toEqual([text('look'), text(IMAGE_OMITTED_TEXT)]);
    expect(out.messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
      content: [text(IMAGE_OMITTED_TEXT)],
    });
    expect(notes.join()).toContain('2 张图片');
  });

  it('Chat image_url, Responses input_image, Gemini inlineData', () => {
    const c = applyRequestFixes(cand('chat', { vision: false }), {
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: [text('hi'), { type: 'image_url', image_url: { url: 'data:x' } }],
        },
      ],
    }) as J;
    expect(c.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(c.messages[1].content[1]).toEqual(text(IMAGE_OMITTED_TEXT));

    const r = applyRequestFixes(cand('responses', { vision: false }), {
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'hi' },
            { type: 'input_image', image_url: 'data:x' },
          ],
        },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [{ type: 'input_image', image_url: 'data:y' }],
        },
      ],
    }) as J;
    expect(r.input[0].content[1]).toEqual({ type: 'input_text', text: IMAGE_OMITTED_TEXT });
    expect(r.input[1].output).toEqual([{ type: 'input_text', text: IMAGE_OMITTED_TEXT }]);

    const g = applyRequestFixes(cand('gemini', { vision: false }), {
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'hi' },
            { inlineData: { mimeType: 'image/png', data: PNG } },
            { inlineData: { mimeType: 'application/pdf', data: PNG } },
          ],
        },
      ],
    }) as J;
    expect(g.contents[0].parts[1]).toEqual({ text: IMAGE_OMITTED_TEXT });
    expect(g.contents[0].parts[2].inlineData.mimeType).toBe('application/pdf');
  });

  it('keeps images when the model supports vision or metadata is missing', () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
    };
    // 目录没收录的模型：不知道就不动
    const unknown = cand('chat', {});
    unknown.provider.models[0]!.id = 'house-model';
    unknown.publicModel = 'ds/house-model';
    expect(applyRequestFixes(unknown, body)).toEqual(body);
    // 用户设置优先于目录（目录说 deepseek-v4-pro 只收文本）
    expect(applyRequestFixes(cand('chat', { vision: true }), body)).toEqual(body);
    expect(JSON.stringify(applyRequestFixes(cand('chat'), body))).toContain(IMAGE_OMITTED_TEXT);
  });
});

describe('tool schema cleanup', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    examples: [{ path: 'a' }],
    properties: {
      // 名叫 examples 的属性必须保留
      examples: { type: 'array', items: { type: 'string', examples: ['x'] } },
      path: { type: 'string', format: 'uri', default: { examples: 1 } },
      mode: { anyOf: [{ type: 'string', examples: ['a'] }, { type: 'null' }] },
    },
    required: ['path'],
    additionalProperties: false,
  };
  const cleaned = {
    type: 'object',
    properties: {
      examples: { type: 'array', items: { type: 'string' } },
      path: { type: 'string', format: 'uri', default: { examples: 1 } },
      mode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['path'],
    additionalProperties: false,
  };

  it('strips $schema and examples structurally, keeping property names and values', () => {
    expect(cleanToolSchema(schema)).toEqual(cleaned);
  });

  it('applies to every wire on third-party upstreams, only on the upstream copy', () => {
    const m = applyRequestFixes(cand('messages'), {
      tools: [
        { name: 'a', input_schema: schema },
        { type: 'web_search_20250305', name: 'ws' },
      ],
    }) as J;
    expect(m.tools[0].input_schema).toEqual(cleaned);
    // 与普通工具混在一起的服务端工具在第三方上游被去掉（见下方 server tools）
    expect(m.tools).toHaveLength(1);
    const c = applyRequestFixes(cand('chat'), {
      tools: [{ type: 'function', function: { name: 'a', parameters: schema } }],
    }) as J;
    expect(c.tools[0].function.parameters).toEqual(cleaned);
    const r = applyRequestFixes(cand('responses'), {
      tools: [{ type: 'function', name: 'a', parameters: schema }],
    }) as J;
    expect(r.tools[0].parameters).toEqual(cleaned);
    const g = applyRequestFixes(cand('gemini'), {
      tools: [{ functionDeclarations: [{ name: 'a', parametersJsonSchema: schema }] }],
    }) as J;
    expect(g.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(cleaned);
    expect(schema.$schema).toBeDefined();
  });

  it('leaves official Anthropic / OpenAI upstreams untouched', () => {
    const body = { tools: [{ name: 'a', input_schema: schema }] };
    expect(applyRequestFixes(cand('messages', {}, anthropicOfficial), body)).toEqual(body);
    const chat = { tools: [{ type: 'function', function: { name: 'a', parameters: schema } }] };
    expect(
      applyRequestFixes(cand('chat', {}, { urls: { chat: 'https://api.openai.com/v1' } }), chat),
    ).toEqual(chat);
  });
});

describe('tool count limit', () => {
  const tools = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `t${i}`, input_schema: { type: 'object' } }));

  it('reports a clear error above quirks.maxTools', () => {
    const c = cand('messages', {}, { quirks: { maxTools: 128 } });
    expect(toolLimitError(c, { tools: tools(128) })).toBeNull();
    expect(toolLimitError(c, { tools: tools(130) })).toBe(
      '当前供应商一次最多支持 128 个工具，这次请求带了 130 个，请减少 MCP 工具',
    );
    expect(toolLimitError(cand('messages'), { tools: tools(500) })).toBeNull();
  });

  it('counts Gemini function declarations', () => {
    const c = cand('gemini', {}, { quirks: { maxTools: 2 } });
    expect(
      toolLimitError(c, {
        tools: [{ functionDeclarations: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }],
      }),
    ).toContain('带了 3 个');
  });
});

describe('Messages toward third-party upstreams', () => {
  it('merges role:system messages into the top-level system, in order', () => {
    const out = applyRequestFixes(cand('messages'), {
      system: 'base',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'cap 1' },
        { role: 'assistant', content: 'ok' },
        { role: 'system', content: 'cap 2' },
      ],
    }) as J;
    expect(out.system).toBe('base\n\ncap 1\n\ncap 2');
    expect(out.messages.map((m: J) => m.role)).toEqual(['user', 'assistant']);
  });

  it('merges block content into a block system', () => {
    const out = applyRequestFixes(cand('messages'), {
      system: [{ type: 'text', text: 'base', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'cap' }] },
        { role: 'user', content: 'hi' },
      ],
    }) as J;
    expect(out.system).toEqual([
      { type: 'text', text: 'base', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'cap' },
    ]);
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
    const noSys = applyRequestFixes(cand('messages'), {
      messages: [
        { role: 'system', content: 'cap' },
        { role: 'user', content: 'hi' },
      ],
    }) as J;
    expect(noSys.system).toBe('cap');
  });

  it('drops Anthropic-only fields; Anthropic official keeps everything', () => {
    const body = {
      messages: [{ role: 'system', content: 'cap' }],
      output_config: { effort: 'high' },
      context_management: { edits: [] },
    };
    const out = applyRequestFixes(cand('messages'), body) as J;
    expect(out.output_config).toBeUndefined();
    expect(out.context_management).toBeUndefined();
    expect(applyRequestFixes(cand('messages', {}, anthropicOfficial), body)).toEqual(body);
  });

  it('filters context-1m and context-management betas for third parties only', () => {
    expect(
      filterAnthropicBeta(
        'context-1m-2025-08-07, interleaved-thinking-2025-05-14,context-management-2025-06-27',
      ),
    ).toBe('interleaved-thinking-2025-05-14');
    const clientHeaders = {
      'anthropic-beta': 'context-1m-2025-08-07,interleaved-thinking-2025-05-14',
    };
    const third = upstreamHeaders(cand('messages'), {
      stream: true,
      clientHeaders,
      sameWire: true,
    });
    expect(third['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    const only1m = upstreamHeaders(cand('messages'), {
      stream: true,
      clientHeaders: { 'anthropic-beta': 'context-1m-2025-08-07' },
      sameWire: true,
    });
    expect(only1m['anthropic-beta']).toBeUndefined();
    const official = upstreamHeaders(cand('messages', {}, anthropicOfficial), {
      stream: true,
      clientHeaders,
      sameWire: true,
    });
    expect(official['anthropic-beta']).toBe(clientHeaders['anthropic-beta']);
  });
});

describe('upstreamBody applies the fixes on both paths', () => {
  it('same-protocol passthrough: surgical, unknown fields kept', () => {
    const out = upstreamBody(
      'messages',
      cand('messages', { maxOutput: 8192, vision: false }),
      {
        model: 'claude-x',
        max_tokens: 32000,
        future_field: { a: 1 },
        messages: [
          { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'u' } }] },
        ],
      },
      { stream: true },
    ) as J;
    expect(out).toMatchObject({
      model: 'deepseek-v4-pro',
      max_tokens: 8192,
      future_field: { a: 1 },
    });
    expect(out.messages[0].content[0]).toEqual({ type: 'text', text: IMAGE_OMITTED_TEXT });
  });

  it('converted path: Messages → Chat is clamped and images replaced', () => {
    const notes: string[] = [];
    const out = upstreamBody(
      'messages',
      cand('chat', { maxOutput: 8192, vision: false }),
      {
        model: 'claude-x',
        max_tokens: 32000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'see' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
            ],
          },
        ],
      },
      { stream: true, notes },
    ) as J;
    expect(out.max_tokens).toBe(8192);
    expect(JSON.stringify(out)).not.toContain('image_url');
    expect(JSON.stringify(out)).toContain(IMAGE_OMITTED_TEXT);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('Codex include:[reasoning.encrypted_content] is dropped when converted, kept on same wire', () => {
    const body = {
      model: 'gpt-x',
      include: ['reasoning.encrypted_content'],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    };
    for (const w of ['chat', 'messages', 'gemini'] as const) {
      const out = upstreamBody('responses', cand(w), body, { stream: false }) as J;
      expect(out.include).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain('encrypted_content');
    }
    const same = upstreamBody('responses', cand('responses'), body, { stream: false }) as J;
    expect(same.include).toEqual(['reasoning.encrypted_content']);
  });
});

describe('server tools (web_search / web_fetch)', () => {
  const search = { type: 'web_search_20250305', name: 'web_search', max_uses: 8 };
  const fetchTool = { type: 'web_fetch_20250910', name: 'web_fetch' };
  const bash = { name: 'Bash', input_schema: { type: 'object' } };
  const ask = { model: 'm', messages: [{ role: 'user', content: 'search x' }] };

  it('a dedicated server-tool request fails before sending on a third-party upstream', () => {
    const c = cand('messages');
    const msg = '当前模型不支持联网搜索（DeepSeek）';
    expect(serverToolError(c, 'messages', { ...ask, tools: [search] })).toBe(msg);
    // tool_choice 强制用服务端工具也算单独发起
    expect(
      serverToolError(c, 'messages', {
        ...ask,
        tools: [bash, search],
        tool_choice: { type: 'tool', name: 'web_search' },
      }),
    ).toBe(msg);
    // 跨协议：入口请求体里有，上游副本里已被解码器丢掉，所以按入口检查
    expect(serverToolError(cand('chat'), 'messages', { ...ask, tools: [fetchTool] })).toBe(msg);
    // 同协议时上游副本保留了服务端工具，toolLimitError 一并拦下
    const sent = upstreamBody('messages', c, { ...ask, tools: [search] }, { stream: false }) as J;
    expect(sent.tools).toEqual([search]);
    expect(toolLimitError(c, sent)).toBe(msg);
  });

  it('passes through untouched on Anthropic official and for other ingress protocols', () => {
    const official = cand('messages', {}, anthropicOfficial);
    expect(serverToolError(official, 'messages', { ...ask, tools: [search] })).toBeNull();
    expect(toolLimitError(official, { ...ask, tools: [search] })).toBeNull();
    const out = applyRequestFixes(official, { ...ask, tools: [bash, search] }) as J;
    expect(out.tools).toEqual([bash, search]);
    expect(serverToolError(cand('chat'), 'chat', { ...ask, tools: [search] })).toBeNull();
  });

  it('mixed with normal tools: server tools are dropped from the upstream copy with a note', () => {
    const c = cand('messages');
    const body = { ...ask, tools: [bash, search, fetchTool] };
    expect(serverToolError(c, 'messages', body)).toBeNull();
    const notes: string[] = [];
    const out = applyRequestFixes(c, body, notes) as J;
    expect(out.tools).toEqual([bash]);
    expect(body.tools).toHaveLength(3);
    expect(notes).toContain('服务端工具 web_search、web_fetch 已去掉（上游不是 Anthropic 官方）');
    expect(toolLimitError(c, out)).toBeNull();
  });
});

describe('quirks.extraBody', () => {
  const minimax = { quirks: { extraBody: { chat: { reasoning_split: true } } } };

  it('merges the fields for the upstream wire after conversion', () => {
    const c = cand('chat', {}, minimax);
    const out = upstreamBody(
      'messages',
      c,
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { stream: true },
    ) as J;
    expect(out).toMatchObject({ model: 'deepseek-v4-pro', reasoning_split: true, stream: true });
    const same = upstreamBody('chat', c, { model: 'x', messages: [] }, { stream: false }) as J;
    expect(same.reasoning_split).toBe(true);
  });

  it('only applies to its own wire, and dropParams still wins', () => {
    expect(
      (applyRequestFixes(cand('messages', {}, minimax), { messages: [] }) as J).reasoning_split,
    ).toBeUndefined();
    const c = { ...cand('chat', {}, minimax), dropParams: ['reasoning_split'] };
    const out = upstreamBody('chat', c, { model: 'x', messages: [] }, { stream: false }) as J;
    expect(out).not.toHaveProperty('reasoning_split');
  });
});
