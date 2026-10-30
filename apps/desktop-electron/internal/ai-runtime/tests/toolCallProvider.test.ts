import type { ChatRequest, ToolDefinition, ToolExecContext } from '@nomi-ai/bundle-ig-base';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AiSdkLlmProvider } from '../src/ai-sdk/AiSdkLlmProvider';
import { toAiSdkTool } from '../src/ai-sdk/mapTools';
import { TrackedProvider } from '../src/providers/ProviderRouter';

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};

function toolLoopModel() {
  const steps = [
    [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'probe', input: '{}' },
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
  let i = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[Math.min(i++, steps.length - 1)] as never[]),
    }),
  });
}

function probeTool(seen: ToolExecContext[]): ToolDefinition {
  return {
    name: 'probe',
    description: 'records the execution context',
    input: z.object({}).strict(),
    execute: async (_i, ctx) => {
      seen.push(ctx);
      return { ok: true };
    },
  };
}

const req = {
  reqId: 'r1',
  messages: [{ role: 'user', content: 'hi' }],
} as unknown as ChatRequest;

async function drain(it: AsyncIterable<unknown>) {
  for await (const _ of it) void _;
}

describe('工具执行上下文带上实际接收 provider（#17）', () => {
  it('toAiSdkTool 把 provider 放进 ctx；不传则没有 provider 字段', async () => {
    const seen: ToolExecContext[] = [];
    const def = probeTool(seen);
    const exec = (t: unknown) =>
      (t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
        {},
        { toolCallId: 'x', messages: [] },
      );
    await exec(toAiSdkTool(def, { id: 'p-cloud', baseURL: 'https://api.example.com/v1' }));
    await exec(toAiSdkTool(def));
    expect(seen[0]!.provider).toEqual({ id: 'p-cloud', baseURL: 'https://api.example.com/v1' });
    expect(seen[1]).not.toHaveProperty('provider');
  });

  it('AiSdkLlmProvider.withTools：工具循环里 ctx.provider 是跑循环的 provider', async () => {
    const seen: ToolExecContext[] = [];
    const provider = new AiSdkLlmProvider({
      id: 'p-cloud',
      apiKey: 'k',
      baseURL: 'https://api.example.com/v1',
    });
    (provider as unknown as { modelFactory: unknown }).modelFactory = () => toolLoopModel();
    await drain(provider.withTools([probeTool(seen)]).stream(req));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.provider).toEqual({ id: 'p-cloud', baseURL: 'https://api.example.com/v1' });
  });

  it('经统一网关：ctx.provider 是真正的上游，不是网关的本机回环地址', async () => {
    const seen: ToolExecContext[] = [];
    const viaGateway = new AiSdkLlmProvider({
      id: 'nomi-gateway',
      apiKey: 'nomi-gw-nomi-x',
      baseURL: 'http://127.0.0.1:18721/v1',
      receiver: { id: 'deepseek', baseURL: 'https://api.deepseek.com/v1' },
    });
    (viaGateway as unknown as { modelFactory: unknown }).modelFactory = () => toolLoopModel();
    await drain(viaGateway.withTools([probeTool(seen)]).stream(req));
    expect(seen[0]!.provider).toEqual({ id: 'deepseek', baseURL: 'https://api.deepseek.com/v1' });
  });

  it('经 TrackedProvider（多 key 包装）同样带上，且是被调用的 provider 而非别的角色', async () => {
    const seen: ToolExecContext[] = [];
    const cloud = new AiSdkLlmProvider({
      id: 'p-cloud',
      apiKey: 'k',
      baseURL: 'https://api.example.com/v1',
    });
    (cloud as unknown as { modelFactory: unknown }).modelFactory = () => toolLoopModel();
    const tracked = new TrackedProvider('p-cloud', [cloud]);
    await drain(tracked.withTools([probeTool(seen)]).stream(req));
    expect(seen[0]!.provider?.id).toBe('p-cloud');
  });
});
