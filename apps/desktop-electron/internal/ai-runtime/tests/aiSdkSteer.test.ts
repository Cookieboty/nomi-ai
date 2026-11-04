/** Nomi 一轮进行中插入用户消息：放回每一步消息列表的位置，前缀标明是用户后来补充的 */
import type { ChatRequest } from '@nomi-ai/bundle-ig-base';
import { jsonSchema, tool } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { AiSdkLlmProvider, STEER_PREFIX, withSteerInserts } from '../src/ai-sdk/AiSdkLlmProvider';

describe('withSteerInserts', () => {
  const base = [
    { role: 'user' as const, content: 'q' },
    { role: 'assistant' as const, content: 'calling tool' },
    { role: 'tool' as const, content: [] },
  ];

  it('按收到时的位置插入，同一位置按收到顺序，之后每一步都带着', () => {
    const out = withSteerInserts(base, [
      { at: 3, text: 'first' },
      { at: 3, text: 'second' },
      { at: 1, text: 'early' },
    ]);
    expect(out.map((m) => (m.role === 'user' ? m.content : m.role))).toEqual([
      'q',
      `${STEER_PREFIX}\nearly`,
      'assistant',
      'tool',
      `${STEER_PREFIX}\nfirst`,
      `${STEER_PREFIX}\nsecond`,
    ]);
    expect(base).toHaveLength(3);
  });

  it('没有插入：原样', () => {
    expect(withSteerInserts(base, [])).toEqual(base);
  });
});

describe('AiSdkLlmProvider.steer', () => {
  const usage = {
    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 3, reasoning: 0 },
  };

  it('工具执行期间插入：下一步的请求带上这条用户消息；请求结束后不再收', async () => {
    const provider = new AiSdkLlmProvider({
      id: 'test',
      apiKey: 'k',
      baseURL: 'http://x',
    } as never);
    const prompts: unknown[] = [];
    let i = 0;
    const steps = [
      [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'look', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
      ],
      [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'ok' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ],
    ];
    (provider as unknown as { modelFactory: unknown }).modelFactory = () =>
      new MockLanguageModelV3({
        doStream: async (opts: { prompt: unknown }) => {
          prompts.push(opts.prompt);
          return { stream: convertArrayToReadableStream(steps[Math.min(i++, 1)] as never[]) };
        },
      });
    const tools = {
      look: tool({
        description: 'look',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: async () => {
          expect(provider.steer('r1', '顺便看看文档')).toBe(true);
          return 'seen';
        },
      }),
    };
    const req = {
      reqId: 'r1',
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ChatRequest;
    for await (const _ of (
      provider as unknown as { runStream(r: ChatRequest, t: unknown): AsyncIterable<unknown> }
    ).runStream(req, tools));
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[0])).not.toContain('顺便看看文档');
    const last = (prompts[1] as Array<{ role: string; content: unknown }>).at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain(`${STEER_PREFIX}\\n顺便看看文档`);
    expect(provider.steer('r1', 'late')).toBe(false);
  });
});

describe('AiSdkLlmProvider.steer 在最后一步收到', () => {
  const usage = {
    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 3, reasoning: 0 },
  };
  const text = (t: string) => [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: t },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];

  it('没有下一步可并进去：带上它续跑一轮，只出一次 done，用量合并；结束后不再收', async () => {
    const provider = new AiSdkLlmProvider({
      id: 'test',
      apiKey: 'k',
      baseURL: 'http://x',
    } as never);
    const prompts: unknown[] = [];
    let i = 0;
    const steps = [text('first'), text('second')];
    (provider as unknown as { modelFactory: unknown }).modelFactory = () =>
      new MockLanguageModelV3({
        doStream: async (opts: { prompt: unknown }) => {
          prompts.push(opts.prompt);
          return { stream: convertArrayToReadableStream(steps[Math.min(i++, 1)] as never[]) };
        },
      });
    const tools = {
      noop: tool({
        description: 'noop',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: async () => 'x',
      }),
    };
    const req = {
      reqId: 'r2',
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ChatRequest;
    const chunks: Array<{ type: string; usage?: { promptTokens: number } }> = [];
    for await (const c of (
      provider as unknown as { runStream(r: ChatRequest, t: unknown): AsyncIterable<never> }
    ).runStream(req, tools)) {
      chunks.push(c);
      if ((c as { type: string }).type === 'delta' && chunks.length === 1)
        expect(provider.steer('r2', '再补一句')).toBe(true);
    }
    expect(prompts).toHaveLength(2);
    const last = (prompts[1] as Array<{ role: string; content: unknown }>).at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('再补一句');
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
    expect(chunks.find((c) => c.type === 'usage')?.usage?.promptTokens).toBe(10);
    expect(provider.steer('r2', 'late')).toBe(false);
  });
});
