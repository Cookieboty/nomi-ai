/**
 * 各 CLI 的「当前上下文」= 最后一次模型请求（输入 + 输出），不是整轮累计。
 * 样本取自 2026-10-23 实测（Codex 0.163.0 app-server、Grok 1.0.67 streaming-json / ACP）；
 * Gemini 0.65 / dsh 0.2.1 按源码里的事件形状。
 */
import { acpMetaContext, createDshParser, createGrokParser } from '@nomi-ai/cli-plugins/main';
import { codexLastContext, createGeminiMapper } from '@nomi-ai/cli-sdk';

import '../../../src/cli/pluginI18n';
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

/** 一轮进行中的实时上下文（context 事件）：自动压缩后下一次请求就回到真实值，不必等轮末 */
describe('live context events per CLI', () => {
  const live = (events: HarnessEvent[]) => events.filter((e) => e.type === 'context');

  it('grok streaming-json: one context event per request line', () => {
    const parse = createGrokParser();
    const line = (usage: Record<string, number>) => JSON.stringify({ type: 'usage', usage });
    expect(
      live(parse(line({ input_tokens: 229, output_tokens: 33, cache_read_input_tokens: 19456 }))),
    ).toEqual([{ type: 'context', tokens: 229 + 19456 + 33 }]);
    // 压缩后
    expect(live(parse(line({ input_tokens: 3000, output_tokens: 10 })))).toEqual([
      { type: 'context', tokens: 3010 },
    ]);
  });

  it('gemini / grok ACP: each usage_update carries tokens + window', () => {
    const m = createGeminiMapper();
    expect(m.update({ sessionUpdate: 'usage_update', used: 900_000, size: 1_048_576 })).toEqual([
      { type: 'context', tokens: 900_000, window: 1_048_576 },
    ]);
    expect(m.update({ sessionUpdate: 'usage_update', used: 40_000 })).toEqual([
      { type: 'context', tokens: 40_000 },
    ]);
    expect(m.update({ sessionUpdate: 'usage_update' })).toEqual([]);
  });

  it('dsh: each step_end emits the step context, the rest of the line still parses', () => {
    const parse = createDshParser();
    const step = (usage: Record<string, number>) =>
      JSON.stringify({ type: 'status', phase: 'step_end', usage });
    expect(live(parse(step({ totalTokens: 250_000 })))).toEqual([
      { type: 'context', tokens: 250_000 },
    ]);
    expect(live(parse(step({ inputTokens: 8000, outputTokens: 200 })))).toEqual([
      { type: 'context', tokens: 8200 },
    ]);
    // 非 step_end 行不发
    expect(live(parse(JSON.stringify({ type: 'final', text: 'OK' })))).toEqual([]);
  });
});
