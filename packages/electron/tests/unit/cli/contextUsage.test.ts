/**
 * 各 CLI 的「当前上下文」= 最后一次模型请求（输入 + 输出），不是整轮累计。
 * 样本取自 2026-10-23 实测（Codex 0.163.0 app-server、Grok 1.0.67 streaming-json / ACP）；
 * Gemini 0.65 / dsh 0.2.1 按源码里的事件形状。
 */
import { codexLastContext } from '../../../src/cli/codex/appServer';
import { createGeminiMapper } from '../../../src/cli/gemini/geminiEvents';
import { acpMetaContext, createDshParser, createGrokParser } from '../../../src/cli/streamParse';
import type { HarnessEvent } from '../../../src/cli/types';

const doneUsages = (events: HarnessEvent[]) =>
  events.flatMap((e) => (e.type === 'done' && e.usage ? [e.usage] : []));

describe('current context per CLI', () => {
  it('codex app-server: tokenUsage.last + modelContextWindow', () => {
    expect(
      codexLastContext({
        total: {
          totalTokens: 30852,
          inputTokens: 30682,
          cachedInputTokens: 10560,
          outputTokens: 170,
        },
        last: { totalTokens: 10742, inputTokens: 10736, cachedInputTokens: 10560, outputTokens: 6 },
        modelContextWindow: 121600,
      }),
    ).toEqual({ contextTokens: 10742, contextWindow: 121600 });
  });

  it('grok streaming-json: last per-request usage line; end.usage is the turn total', () => {
    const parse = createGrokParser();
    const lines = [
      { input_tokens: 12474, output_tokens: 139, cache_read_input_tokens: 7040 },
      { input_tokens: 229, output_tokens: 33, cache_read_input_tokens: 19456 },
      { input_tokens: 149, output_tokens: 16, cache_read_input_tokens: 19584 },
    ].map((usage) => JSON.stringify({ type: 'usage', usage }));
    const end = JSON.stringify({
      type: 'end',
      text: 'OK',
      usage: { input_tokens: 12852, cache_read_input_tokens: 46080, output_tokens: 188 },
    });
    const usages = doneUsages([...lines, end].flatMap((l) => parse(l)));
    // 合并后（后者覆盖前者）：计费取 end 的累计，上下文保留最后一次请求
    const merged = usages.reduce((a, b) => ({ ...a, ...b }), {});
    expect(merged).toMatchObject({
      inputTokens: 12852,
      cacheReadTokens: 46080,
      outputTokens: 188,
      contextTokens: 149 + 19584 + 16,
    });
  });

  it('grok ACP: _meta.inputTokens/outputTokens are the last request', () => {
    expect(
      acpMetaContext({ inputTokens: 19994, outputTokens: 73, usage: { inputTokens: 39387 } }),
    ).toEqual({
      contextTokens: 20067,
    });
    expect(acpMetaContext(undefined)).toEqual({});
  });

  it('gemini ACP: last usage_update {used, size}', () => {
    const m = createGeminiMapper();
    m.update({ sessionUpdate: 'usage_update', used: 9000, size: 1_048_576 });
    m.update({ sessionUpdate: 'usage_update', used: 12000, size: 1_048_576 });
    expect(m.context()).toEqual({ contextTokens: 12000, contextWindow: 1_048_576 });
  });

  it('dsh: step_end usage summed for billing, last step totalTokens as context', () => {
    const parse = createDshParser();
    const step = (usage: Record<string, number>) =>
      JSON.stringify({ type: 'status', phase: 'step_end', usage });
    parse(step({ inputTokens: 900, outputTokens: 50, cacheReadTokens: 100, totalTokens: 1050 }));
    parse(step({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 1000, totalTokens: 1220 }));
    const usages = doneUsages(parse(JSON.stringify({ type: 'final', text: 'OK' })));
    expect(usages).toEqual([
      { inputTokens: 1100, outputTokens: 70, cacheReadTokens: 1100, contextTokens: 1220 },
    ]);
  });
});
