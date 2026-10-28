import { LLMRegistryKey, ToolRegistryKey, UserProfileKey, echoTool } from '@nomi-ai/bundle-ig-base';
import { describe, expect, it, vi } from 'vitest';

import { AiSdkLlmProvider, createAiSdkProviderFromEntry } from '../src/ai-sdk/AiSdkLlmProvider';
import { toAiSdkToolSet } from '../src/ai-sdk/mapTools';
import { createAiSdkBooter, defaultAiSdkPlugins } from '../src/AiSdkBooter';
import { NoopRuntimeLogger } from '../src/logger';

describe('createAiSdkBooter', () => {
  it('boots IgPluginHost with AI SDK providers (no 插件宿主)', async () => {
    const booter = createAiSdkBooter({
      logger: NoopRuntimeLogger,
      env: { DEEPSEEK_API_KEY: 'sk-test', DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1' },
    });
    const ctx = await booter.boot('companion', { home: '/tmp' });
    const ids = ctx
      .inject(LLMRegistryKey)!
      .list()
      .map((p) => p.id);
    expect(ids).toEqual(['deepseek', 'ollama', 'openai', 'claude', 'gemini']);
    const deepseek = ctx.inject(LLMRegistryKey)!.get('deepseek');
    expect(deepseek).toBeInstanceOf(AiSdkLlmProvider);
    expect(
      ctx
        .inject(ToolRegistryKey)!
        .list()
        .map((t) => t.name),
    ).toEqual(expect.arrayContaining(['time_now', 'echo']));
    expect(ctx.inject(UserProfileKey)!.get()).toHaveProperty('identity');
    await booter.dispose?.();
  });

  it('defaultAiSdkPlugins swaps LLMProvidersPlugin for AiSdkLLMProvidersPlugin', () => {
    const names = defaultAiSdkPlugins('companion').map((e) => e.plugin.name);
    expect(names).toContain('AiSdkLLMProvidersPlugin');
    expect(names).not.toContain('LLMProvidersPlugin');
  });
});

describe('toAiSdkToolSet', () => {
  it('maps ToolDefinition to an executable AI SDK tool', async () => {
    const set = toAiSdkToolSet([echoTool]);
    expect(Object.keys(set)).toEqual(['echo']);
    const out = await set.echo!.execute!({ text: 'hi' }, {
      toolCallId: 't1',
      messages: [],
      abortSignal: undefined as never,
    } as never);
    expect(out).toBe('hi');
  });

  it('forwards conversationId into ToolExecContext (#116)', async () => {
    let seen: { conversationId?: string } | undefined;
    const tool = {
      ...echoTool,
      id: 'echo',
      execute: async (_input: { text: string }, ctx: { conversationId?: string }) => {
        seen = ctx;
        return 'ok';
      },
    };
    const set = toAiSdkToolSet([tool], { conversationId: 'conv-42', reqId: 'r1' });
    await set.echo!.execute!({ text: 'x' }, {
      toolCallId: 't1',
      messages: [],
      abortSignal: undefined as never,
    } as never);
    expect(seen?.conversationId).toBe('conv-42');
  });

  it('forwards the conversation workspace and hides workspace-only tools without one', async () => {
    let seen: { cwd?: string } | undefined;
    const wsTool = {
      ...echoTool,
      name: 'ws_only',
      requiresWorkspace: true,
      execute: async (_input: unknown, ctx: { cwd?: string }) => {
        seen = ctx;
        return 'ok';
      },
    };
    expect(Object.keys(toAiSdkToolSet([echoTool, wsTool], { reqId: 'r1' }))).toEqual(['echo']);
    const set = toAiSdkToolSet([echoTool, wsTool], { reqId: 'r1', cwd: '/w/proj' });
    expect(Object.keys(set)).toEqual(['echo', 'ws_only']);
    await set.ws_only!.execute!({ text: 'x' }, {
      toolCallId: 't1',
      messages: [],
      abortSignal: undefined as never,
    } as never);
    expect(seen?.cwd).toBe('/w/proj');
  });
});

describe('AiSdkLlmProvider', () => {
  it('assertKey throws when api key required but missing', async () => {
    const p = new AiSdkLlmProvider({
      id: 'deepseek',
      baseURL: 'http://127.0.0.1:9/v1',
      requiresApiKey: true,
    });
    await expect(
      p.chat({
        reqId: 'r1',
        provider: 'deepseek',
        model: 'default',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/API key is not configured/);
  });

  it('folds ChatMessage system roles into AI SDK instructions (AI SDK 7)', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>;
      };
      // OpenAI wire format may still carry a system message; the important part is
      // generateText no longer rejects our ChatMessage[] that includes role:system.
      expect(body.messages?.some((m) => m.role === 'user')).toBe(true);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const p = new AiSdkLlmProvider({
      id: 'openai',
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: 'sk',
      requiresApiKey: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const resp = await p.chat({
      reqId: 'r-sys',
      provider: 'openai',
      model: 'mock',
      messages: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(resp.content).toBe('ok');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('streams deltas from a mock OpenAI-compatible server', async () => {
    const fetchImpl = vi.fn(async () => {
      const body = [
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join('');
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const p = new AiSdkLlmProvider({
      id: 'openai',
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: 'sk',
      requiresApiKey: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks: string[] = [];
    for await (const c of p.stream({
      reqId: 'r2',
      provider: 'openai',
      model: 'mock',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) {
      if (c.type === 'delta') chunks.push(c.content);
    }
    expect(chunks.join('')).toContain('hel');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('anthropic protocol → POST {base}/v1/messages via @ai-sdk/anthropic (mock fetch)', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      expect(body.model).toBe('claude-sonnet-4-5');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('sk-ant');
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'bonjour' }],
          model: 'claude-sonnet-4-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const p = new AiSdkLlmProvider({
      id: 'any-anthropic-gateway',
      protocol: 'anthropic',
      baseURL: 'https://gw.example.com',
      apiKey: 'sk-ant',
      defaultModel: 'claude-sonnet-4-5',
      requiresApiKey: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const resp = await p.chat({
      reqId: 'c1',
      provider: 'x',
      model: 'default',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(resp.content).toContain('bonjour');
    expect(urls).toEqual(['https://gw.example.com/v1/messages']);
  });

  it('openai-responses protocol → POST {base}/responses via @ai-sdk/openai (mock fetch)', async () => {
    const urls: string[] = [];
    const models: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      models.push((JSON.parse(String(init?.body ?? '{}')) as { model: string }).model);
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          object: 'response',
          created_at: 1,
          model: 'gpt-x',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'namaste', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const p = new AiSdkLlmProvider({
      id: 'resp',
      protocol: 'openai-responses',
      baseURL: 'https://gw.example.com/v1',
      apiKey: 'k',
      defaultModel: 'alias',
      modelMap: [{ from: 'alias', to: 'gpt-x' }],
      requiresApiKey: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const resp = await p.chat({
      reqId: 'r',
      provider: 'resp',
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(resp.content).toBe('namaste');
    expect(urls).toEqual(['https://gw.example.com/v1/responses']);
    expect(models).toEqual(['gpt-x']);
  });

  it('full URL toggle sends to the URL as-is (openai-chat)', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    const p = new AiSdkLlmProvider({
      id: 'full',
      protocol: 'openai-chat',
      baseURL: 'https://gw.example.com/custom/chat-endpoint?api-version=1',
      fullUrl: true,
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await p.chat({
      reqId: 'r',
      provider: 'full',
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(urls).toEqual(['https://gw.example.com/custom/chat-endpoint?api-version=1']);
  });

  it('env providers map onto the same generic protocol config', async () => {
    const { envProviderConfig } = await import('../src/ai-sdk/AiSdkLlmProvider');
    expect(envProviderConfig({ id: 'claude', apiKey: 'k' })).toMatchObject({
      protocol: 'anthropic',
      baseURL: 'https://api.anthropic.com/v1',
    });
    expect(envProviderConfig({ id: 'gemini', apiKey: 'k' })).toMatchObject({
      protocol: 'openai-chat',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
    expect(envProviderConfig({ id: 'deepseek', baseURL: 'http://x/v1' })).toMatchObject({
      protocol: 'openai-chat',
      baseURL: 'http://x/v1',
      defaultModel: 'deepseek-chat',
    });
    expect(createAiSdkProviderFromEntry({ id: 'gemini', apiKey: 'k' }).id).toBe('gemini');
  });
});
