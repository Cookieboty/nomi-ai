import type { ChatChunk, ChatRequest } from '@nomi-ai/bundle-ig-base';
import { describe, expect, it } from 'vitest';

import { AiSdkLlmProvider } from '../src/ai-sdk/AiSdkLlmProvider';
import { describeStreamError } from '../src/ai-sdk/streamError';

/** 网关发来的 response.failed：缺 sequence_number、code 不规范 → AI SDK 的 schema 校验失败（#78） */
const FAILED_FRAME = {
  type: 'response.failed',
  response: {
    status: 'failed',
    error: {
      message: 'upstream channel request failed',
      type: 'upstream_error',
      param: '',
      code: 'upstream_channel_error',
    },
  },
};

function sse(frames: unknown[]): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function run(fetchImpl: typeof fetch): Promise<ChatChunk[]> {
  const provider = new AiSdkLlmProvider({
    id: 'gw',
    protocol: 'openai-responses',
    apiKey: 'k',
    baseURL: 'http://gateway.test/v1',
    defaultModel: 'm',
    fetchImpl,
  });
  const out: ChatChunk[] = [];
  const req = { reqId: 'r1', messages: [{ role: 'user', content: 'hi' }] } as ChatRequest;
  for await (const c of (
    provider as unknown as { runStream(r: ChatRequest, t: unknown): AsyncIterable<ChatChunk> }
  ).runStream(req, undefined))
    out.push(c);
  return out;
}

describe('describeStreamError（#78）', () => {
  it('real AI SDK path: a malformed response.failed frame becomes `[code] message`', async () => {
    const chunks = await run((async () => sse([FAILED_FRAME])) as typeof fetch);
    const err = chunks.find((c) => c.type === 'error') as { error: string } | undefined;
    expect(err?.error).toBe('[upstream_channel_error] upstream channel request failed');
  });

  it('reads `error` frames, APICallError-like data and wrapped last errors', () => {
    expect(
      describeStreamError({
        value: { type: 'error', error: { code: 'rate_limit_exceeded', message: 'slow down' } },
      }),
    ).toBe('[rate_limit_exceeded] slow down');
    expect(
      describeStreamError({ data: { error: { type: 'insufficient_quota', message: 'no money' } } }),
    ).toBe('[insufficient_quota] no money');
    const inner = { value: FAILED_FRAME };
    expect(describeStreamError({ message: 'Failed after 3 attempts', lastError: inner })).toBe(
      '[upstream_channel_error] upstream channel request failed',
    );
  });

  it('plain errors pass through, long ones are clipped', () => {
    expect(describeStreamError(new Error('Service Unavailable'))).toBe('Service Unavailable');
    const long = describeStreamError(new Error('x'.repeat(2000)));
    expect(long.length).toBeLessThanOrEqual(501);
    expect(long.endsWith('…')).toBe(true);
  });

  it('prefixes HTTP status when present so key-rotation can prefer status codes', () => {
    expect(
      describeStreamError(
        Object.assign(new Error('bad key'), {
          statusCode: 401,
          data: { error: { message: 'nope' } },
        }),
      ),
    ).toBe('HTTP 401: nope');
    expect(
      describeStreamError({
        statusCode: 429,
        data: { error: { type: 'rate_limit_exceeded', message: 'slow' } },
      }),
    ).toBe('HTTP 429: [rate_limit_exceeded] slow');
    // 文案已含状态码时不重复前缀
    expect(
      describeStreamError(Object.assign(new Error('401 unauthorized'), { statusCode: 401 })),
    ).toBe('401 unauthorized');
  });
});
