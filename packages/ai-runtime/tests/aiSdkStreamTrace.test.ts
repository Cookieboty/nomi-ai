import type { ChatChunk, ChatRequest } from '@nomi-ai/bundle-ig-base';
import { jsonSchema, tool } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { AiSdkLlmProvider, stringifyToolOutput } from '../src/ai-sdk/AiSdkLlmProvider';

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};

function modelWith(steps: Array<Array<Record<string, unknown>>>) {
  let i = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[Math.min(i++, steps.length - 1)] as never[]),
    }),
  });
}

async function collect(
  provider: AiSdkLlmProvider,
  tools: Record<string, unknown>,
): Promise<ChatChunk[]> {
  const req = {
    reqId: 'r1',
    messages: [{ role: 'user', content: 'hi' }],
  } as unknown as ChatRequest;
  const out: ChatChunk[] = [];
  for await (const c of (
    provider as unknown as {
      runStream(r: ChatRequest, t: unknown): AsyncIterable<ChatChunk>;
    }
  ).runStream(req, tools))
    out.push(c);
  return out;
}

describe('AiSdkLlmProvider.runStream emits tool results and reasoning', () => {
  it('yields reasoning, tool_call.delta with id, tool_call.result, text and usage in order', async () => {
    const provider = new AiSdkLlmProvider({
      id: 'test',
      apiKey: 'k',
      baseURL: 'http://x',
    } as never);
    (provider as unknown as { modelFactory: unknown }).modelFactory = () =>
      modelWith([
        [
          { type: 'stream-start', warnings: [] },
          { type: 'reasoning-start', id: 'r' },
          { type: 'reasoning-delta', id: 'r', delta: '先查一下' },
          { type: 'reasoning-end', id: 'r' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'kb_search', input: '{"q":"nomi"}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
        ],
        [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: '找到了' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ],
      ]);
    const tools = {
      kb_search: tool({
        description: 'search',
        inputSchema: jsonSchema({ type: 'object', properties: { q: { type: 'string' } } }),
        execute: async (input: unknown) => ({
          hits: [{ title: 'doc', q: (input as { q: string }).q }],
        }),
      }),
      bad: tool({
        description: 'bad',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: async () => {
          throw new Error('boom');
        },
      }),
    };
    const chunks = await collect(provider, tools);
    const kinds = chunks.map((c) => c.type);
    expect(kinds.indexOf('reasoning')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('reasoning')).toBeLessThan(kinds.indexOf('tool_call.delta'));
    expect(kinds.indexOf('tool_call.delta')).toBeLessThan(kinds.indexOf('tool_call.result'));
    expect(kinds.indexOf('tool_call.result')).toBeLessThan(kinds.indexOf('delta'));
    expect(chunks.find((c) => c.type === 'reasoning')).toMatchObject({ content: '先查一下' });
    expect(chunks.find((c) => c.type === 'tool_call.delta')).toMatchObject({
      id: 'c1',
      name: 'kb_search',
      argumentsJson: '{"q":"nomi"}',
    });
    const res = chunks.find((c) => c.type === 'tool_call.result') as {
      id: string;
      name: string;
      output?: string;
      error?: string;
    };
    expect(res).toMatchObject({ id: 'c1', name: 'kb_search' });
    expect(JSON.parse(res.output!)).toEqual({ hits: [{ title: 'doc', q: 'nomi' }] });
    expect(res.error).toBeUndefined();
  });

  it('tool errors surface as tool_call.result with error', async () => {
    const provider = new AiSdkLlmProvider({
      id: 'test',
      apiKey: 'k',
      baseURL: 'http://x',
    } as never);
    (provider as unknown as { modelFactory: unknown }).modelFactory = () =>
      modelWith([
        [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'c9', toolName: 'bad', input: '{}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
        ],
        [
          { type: 'stream-start', warnings: [] },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ],
      ]);
    const tools = {
      bad: tool({
        description: 'bad',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: async () => {
          throw new Error('boom');
        },
      }),
    };
    const chunks = await collect(provider, tools);
    expect(chunks.find((c) => c.type === 'tool_call.result')).toMatchObject({
      id: 'c9',
      name: 'bad',
      error: 'boom',
    });
  });
});

describe('stringifyToolOutput', () => {
  it('passes strings, serialises objects, truncates long output', () => {
    expect(stringifyToolOutput('ok')).toBe('ok');
    expect(stringifyToolOutput({ a: 1 })).toBe('{"a":1}');
    expect(stringifyToolOutput(undefined)).toBeUndefined();
    expect(stringifyToolOutput('x'.repeat(7000))!.length).toBeLessThan(6100);
  });
});
