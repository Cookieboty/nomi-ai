/**
 * 统一网关回退到别的候选时，用量按实际服务的模型记账（#97）：只认 servedModelHeader 指定的响应头。
 */
import type { ChatChunk, ChatRequest } from '@nomi-ai/bundle-ig-base';
import { describe, expect, it } from 'vitest';

import { AiSdkLlmProvider } from '../src/ai-sdk/AiSdkLlmProvider';
import { NOMI_REDACTED_HEADER, NOMI_SERVED_MODEL_HEADER } from '../src/providers/ProviderRouter';

const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };

const streamRes = (headers: Record<string, string>) =>
  new Response(
    [
      { id: 'c', choices: [{ index: 0, delta: { content: 'hi' } }] },
      { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
    ]
      .map((f) => `data: ${JSON.stringify(f)}\n\n`)
      .join('') + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } },
  );

const jsonRes = (headers: Record<string, string>) =>
  new Response(
    JSON.stringify({
      id: 'c',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json', ...headers } },
  );

const mk = (res: () => Response, trusted: boolean) =>
  new AiSdkLlmProvider({
    id: 'gw',
    protocol: 'openai-chat',
    apiKey: 'k',
    baseURL: 'http://gateway.test/v1',
    defaultModel: 'a/model-a',
    fetchImpl: (async () => res()) as typeof fetch,
    ...(trusted ? { servedModelHeader: NOMI_SERVED_MODEL_HEADER } : {}),
  });

const req = (stream: boolean) =>
  ({ reqId: 'r1', stream, messages: [{ role: 'user', content: 'hi' }] }) as ChatRequest;

const streamModel = async (p: AiSdkLlmProvider) => {
  const out: ChatChunk[] = [];
  for await (const c of p.stream(req(true))) out.push(c);
  return (out.find((c) => c.type === 'usage') as { model?: string } | undefined)?.model;
};

describe('served model header (#97)', () => {
  const fellBack = { [NOMI_SERVED_MODEL_HEADER]: 'b/model-b' };

  it('stream: usage is booked to the model that actually served the request', async () => {
    expect(await streamModel(mk(() => streamRes(fellBack), true))).toBe('b/model-b');
  });

  it('chat: response model is the served model', async () => {
    expect((await mk(() => jsonRes(fellBack), true).chat(req(false))).model).toBe('b/model-b');
  });

  it('without the header, or for an untrusted upstream, keeps the requested model', async () => {
    expect(await streamModel(mk(() => streamRes({}), true))).toBe('a/model-a');
    expect(await streamModel(mk(() => streamRes(fellBack), false))).toBe('a/model-a');
    expect((await mk(() => jsonRes(fellBack), false).chat(req(false))).model).toBe('a/model-a');
  });
});

describe('redacted header（隐私模式）', () => {
  const mkR = (res: () => Response, trusted: boolean) =>
    new AiSdkLlmProvider({
      id: 'gw',
      protocol: 'openai-chat',
      apiKey: 'k',
      baseURL: 'http://gateway.test/v1',
      defaultModel: 'a/model-a',
      fetchImpl: (async () => res()) as typeof fetch,
      ...(trusted ? { redactedHeader: NOMI_REDACTED_HEADER } : {}),
    });
  const hid = { [NOMI_REDACTED_HEADER]: '2' };

  it('stream / chat: usage carries how many keys the gateway hid', async () => {
    const out: ChatChunk[] = [];
    for await (const c of mkR(() => streamRes(hid), true).stream(req(true))) out.push(c);
    const u = out.find((c) => c.type === 'usage') as { usage: { redacted?: number } };
    expect(u.usage.redacted).toBe(2);
    expect((await mkR(() => jsonRes(hid), true).chat(req(false))).usage?.redacted).toBe(2);
  });

  it('no header, a bad value or an untrusted upstream: nothing', async () => {
    for (const [res, trusted] of [
      [() => jsonRes({}), true],
      [() => jsonRes({ [NOMI_REDACTED_HEADER]: 'x' }), true],
      [() => jsonRes(hid), false],
    ] as const)
      expect((await mkR(res, trusted).chat(req(false))).usage?.redacted).toBeUndefined();
  });
});
