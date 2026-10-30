import { describe, expect, it, vi } from 'vitest';

import type { OpenAICompatOptions } from '../../src/plugins/llm';
import { createProvider } from '../../src/plugins/LLMProvidersPlugin';
import type { ChatChunk, ChatRequest } from '../../src/types/common';

type Opts = Partial<OpenAICompatOptions>;
/** 旧的按厂商类已移除：deepseek / ollama 只是通用 OpenAI 兼容端点的预填默认值 */
const deepseek = (o: Opts = {}) => createProvider({ id: 'deepseek' }, o);
const ollama = (o: Opts = {}) => createProvider({ id: 'ollama' }, o);

function req(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    reqId: 'r1',
    provider: 'deepseek',
    model: 'default',
    messages: [{ role: 'user', content: 'hi' }],
    ...over,
  };
}

function sseResponse(events: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // 故意把事件拆成不规则分片，验证缓冲拼接
      const all = events.map((e) => `data: ${e}\n\n`).join('');
      for (let i = 0; i < all.length; i += 7) controller.enqueue(enc.encode(all.slice(i, i + 7)));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('BaseOpenAICompat', () => {
  it('chat(): POST /chat/completions with bearer key and default model', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
    const p = deepseek({ apiKey: 'sk-test', fetchImpl: fetchImpl as typeof fetch });
    const res = await p.chat(req());

    expect(res).toMatchObject({
      reqId: 'r1',
      provider: 'deepseek',
      model: 'deepseek-chat',
      content: 'hello',
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'deepseek-chat',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('explicit baseURL: undefined keeps provider default (spread order)', () => {
    const p = ollama({ baseURL: undefined });
    expect((p as unknown as { opts: { baseURL: string } }).opts.baseURL).toBe(
      'http://127.0.0.1:11434/v1',
    );
  });

  it('chat(): missing API key on cloud provider fails fast without network', async () => {
    const fetchImpl = vi.fn();
    const p = deepseek({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(p.chat(req())).rejects.toThrow(/API key is not configured/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('chat(): HTTP error surfaces status and body', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad key', { status: 401 }));
    const p = deepseek({ apiKey: 'x', fetchImpl: fetchImpl as typeof fetch });
    await expect(p.chat(req())).rejects.toThrow(/HTTP 401: bad key/);
  });

  it('stream(): parses SSE deltas, usage and done (local provider without key)', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }),
        '[DONE]',
      ]),
    );
    const p = ollama({ fetchImpl: fetchImpl as typeof fetch });
    const chunks = await collect(p.stream(req({ provider: 'ollama', stream: true })));
    expect(chunks).toEqual([
      { type: 'delta', content: 'hel' },
      { type: 'delta', content: 'lo' },
      { type: 'done', finishReason: 'stop' },
      { type: 'usage', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'qwen2.5:3b-instruct',
      stream: true,
    });
  });

  it('stream(): transport error becomes an error chunk', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const p = ollama({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const chunks = await collect(p.stream(req()));
    expect(chunks).toEqual([{ type: 'error', error: 'ECONNREFUSED' }]);
  });
});
