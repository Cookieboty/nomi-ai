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

  describe('Anthropic 计价分档：fast / 1 小时缓存写', () => {
    it('非流式 JSON：保留 1h 子量与 speed=fast；5m / 1h 混合', () => {
      expect(
        usageFromObject({
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 300,
            cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
            speed: 'fast',
          },
        }),
      ).toMatchObject({ cacheWrite: 300, cacheWrite1h: 200, fast: true });
    });

    it('总量字段缺失时用分档之和；1h 子量不超过总量；没有分档 / 标准速度不带字段', () => {
      expect(
        usageFromObject({
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 70 },
          },
        }),
      ).toMatchObject({ cacheWrite: 120, cacheWrite1h: 70 });
      const capped = usageFromObject({
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 40,
          cache_creation: { ephemeral_1h_input_tokens: 90 },
        },
      });
      expect(capped).toMatchObject({ cacheWrite: 40, cacheWrite1h: 40 });
      const plain = usageFromObject({
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 9,
          speed: 'standard',
        },
      })!;
      expect(plain.cacheWrite1h).toBeUndefined();
      expect(plain.fast).toBeUndefined();
    });

    it('拆分 SSE：message_start 的分档与 fast 在 message_delta 之后仍保留', () => {
      const tap = new SseUsageTap();
      const ev = (o: object) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
      const all =
        ev({
          type: 'message_start',
          message: {
            model: 'claude-x',
            usage: {
              input_tokens: 12,
              output_tokens: 1,
              cache_creation_input_tokens: 1000,
              cache_creation: { ephemeral_1h_input_tokens: 600, ephemeral_5m_input_tokens: 400 },
              speed: 'fast',
            },
          },
        }) + ev({ type: 'message_delta', usage: { output_tokens: 42 } });
      tap.push(all.slice(0, 77));
      tap.push(all.slice(77));
      expect(tap.end()).toMatchObject({
        input: 12,
        output: 42,
        cacheWrite: 1000,
        cacheWrite1h: 600,
        fast: true,
      });
    });
  });

  it('取上游响应 / 消息 id：Anthropic message_start、非流式、Responses、Chat；SSE 合并保留首个 id', () => {
    expect(
      usageFromObject({ id: 'msg_a', usage: { input_tokens: 1, output_tokens: 1 } }),
    ).toMatchObject({
      id: 'msg_a',
    });
    expect(
      usageFromObject({ message: { id: 'msg_b', usage: { input_tokens: 1, output_tokens: 1 } } }),
    ).toMatchObject({ id: 'msg_b' });
    expect(
      usageFromObject({ response: { id: 'resp_c', usage: { input_tokens: 5, output_tokens: 1 } } }),
    ).toMatchObject({ id: 'resp_c' });
    expect(
      usageFromObject({ id: 'chatcmpl-d', usage: { prompt_tokens: 5, completion_tokens: 1 } }),
    ).toMatchObject({
      id: 'chatcmpl-d',
    });
    const tap = new SseUsageTap();
    const ev = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
    tap.push(
      ev({
        type: 'message_start',
        message: { id: 'msg_e', usage: { input_tokens: 3, output_tokens: 1 } },
      }) + ev({ type: 'message_delta', usage: { output_tokens: 9 } }),
    );
    expect(tap.end()).toMatchObject({ id: 'msg_e', output: 9 });
  });
});
