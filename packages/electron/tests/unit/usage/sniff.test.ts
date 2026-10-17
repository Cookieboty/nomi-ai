import { emptySniffed, hasTokens, SseUsageTap, usageFromObject } from '../../../src/usage/sniff';

describe('路由响应 usage 嗅探', () => {
  it('Anthropic 非流式', () => {
    expect(
      usageFromObject({
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      }),
    ).toMatchObject({
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite: 20,
      model: 'claude-sonnet-4-5',
    });
  });

  it('OpenAI Chat：prompt 含缓存，拆开', () => {
    expect(
      usageFromObject({
        model: 'gpt-4o',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 60 },
        },
      }),
    ).toMatchObject({ input: 40, cacheRead: 60, output: 20 });
  });

  it('OpenAI Responses（含 response.usage 包装）', () => {
    expect(
      usageFromObject({
        type: 'response.completed',
        response: {
          model: 'gpt-5',
          usage: {
            input_tokens: 50,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 10 },
          },
        },
      }),
    ).toMatchObject({ input: 40, cacheRead: 10, output: 7, model: 'gpt-5' });
  });

  it('Gemini usageMetadata', () => {
    expect(
      usageFromObject({
        usageMetadata: {
          promptTokenCount: 30,
          candidatesTokenCount: 4,
          cachedContentTokenCount: 10,
        },
      }),
    ).toMatchObject({ input: 20, cacheRead: 10, output: 4 });
  });

  it('没有 usage 返回 null', () => {
    expect(usageFromObject({ choices: [] })).toBeNull();
    expect(usageFromObject('x')).toBeNull();
  });

  it('SSE：Anthropic message_start 给输入、message_delta 给最终输出，跨分片', () => {
    const tap = new SseUsageTap();
    const ev = (o: object) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
    const s1 = ev({
      type: 'message_start',
      message: { model: 'claude-x', usage: { input_tokens: 12, output_tokens: 1 } },
    });
    const s2 = ev({ type: 'message_delta', usage: { output_tokens: 42 } }) + 'data: [DONE]\n\n';
    const all = s1 + s2;
    tap.push(all.slice(0, 40));
    tap.push(all.slice(40));
    const u = tap.end();
    expect(u).toMatchObject({ input: 12, output: 42, model: 'claude-x' });
    expect(hasTokens(u)).toBe(true);
  });

  it('SSE：Chat 流最后一包带 usage；没有 usage 则为空', () => {
    const tap = new SseUsageTap();
    tap.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    expect(hasTokens(tap.end())).toBe(false);
    const t2 = new SseUsageTap();
    t2.push(
      'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: [DONE]\n',
    );
    expect(t2.end()).toMatchObject({ input: 8, output: 3 });
    expect(hasTokens(emptySniffed())).toBe(false);
  });
});
