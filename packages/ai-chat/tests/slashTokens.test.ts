import { describe, expect, it } from 'vitest';

import {
  contextWindowFor,
  estimateContext,
  estimateTokens,
  formatTokens,
  formatUsd,
  reportedContextWindow,
  reportedModel,
  withLiveContext,
} from '../src/slash/tokens';
import type { ConvMessage } from '../src/types/conversation';

describe('tokens', () => {
  it('中文约 1 token / 字，英文约 4 字符 1 token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('你好 abcd')).toBe(4);
  });
  it('窗口表：命中 / 默认', () => {
    expect(contextWindowFor('claude-sonnet-4-5')).toEqual({ size: 200_000, source: 'table' });
    expect(contextWindowFor('claude-opus-4[1m]').size).toBe(1_000_000);
    expect(contextWindowFor('gpt-5-codex').size).toBe(400_000);
    // Claude Code 对 claude-opus-5-5 上报的窗口是 1M
    expect(contextWindowFor('claude-opus-5-5').size).toBe(1_000_000);
    expect(contextWindowFor('some-unknown-model')).toEqual({ size: 128_000, source: 'default' });
    expect(contextWindowFor(undefined).source).toBe('default');
  });
  it('格式化', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(12_345)).toBe('12.3K');
    expect(formatTokens(200_000)).toBe('200K');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(1.234)).toBe('$1.23');
  });
});

const labels = {
  user: '用户',
  assistant: '助手',
  tools: '工具',
  thinking: '思考',
  system: '系统',
};

describe('estimateContext：只认 contextTokens', () => {
  it('只有整轮累计用量（无 contextTokens）时不冒充真实用量', () => {
    // Claude result.usage 实测：一轮两次请求，cache_read 是两次之和
    const msgs: ConvMessage[] = [
      { id: 'u1', role: 'user', text: 'hi', at: 1 },
      {
        id: 'a1',
        role: 'assistant',
        text: 'ok',
        at: 2,
        usage: { inputTokens: 4, cacheReadTokens: 36_548, outputTokens: 226 },
      },
    ];
    expect(estimateContext(msgs, labels).basis).toBe('estimate');
  });
  it('CLI 上报的窗口优先于经验表', () => {
    const msgs: ConvMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        text: 'ok',
        at: 2,
        usage: { contextTokens: 25_541, contextWindow: 1_000_000 },
      },
    ];
    expect(reportedContextWindow(msgs)).toBe(1_000_000);
    expect(contextWindowFor('claude-opus-5-5', reportedContextWindow(msgs))).toEqual({
      size: 1_000_000,
      source: 'reported',
    });
    expect(contextWindowFor('claude-opus-5-5').source).toBe('table');
  });
  it('格式化仅用于 token 数：大数字用 K/M', () => {
    expect(formatTokens(14_000_000)).toBe('14M');
    expect(formatTokens(256_000)).toBe('256K');
  });
  it('历史错误累加出 14M 时回退估算，不撑满环', () => {
    const msgs: ConvMessage[] = [
      {
        id: 'u1',
        role: 'user',
        text: '你好',
        at: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        text: '好的',
        at: 2,
        usage: { contextTokens: 14_000_100 },
      },
    ];
    const est = estimateContext(msgs, labels, { windowSize: 256_000 });
    expect(est.basis).toBe('estimate');
    expect(est.used).toBeLessThan(256_000);
    expect(est.used).toBeGreaterThan(0);
  });
  it('正常真实用量保留 actual', () => {
    const msgs: ConvMessage[] = [
      { id: 'u1', role: 'user', text: 'hi', at: 1 },
      {
        id: 'a1',
        role: 'assistant',
        text: 'ok',
        at: 2,
        // 累计口径的字段不参与总量，只看 contextTokens
        usage: {
          inputTokens: 9_999,
          cacheReadTokens: 99_999,
          outputTokens: 40,
          contextTokens: 1240,
        },
      },
    ];
    const est = estimateContext(msgs, labels, { windowSize: 128_000 });
    expect(est.basis).toBe('actual');
    expect(est.used).toBe(1240);
  });
});

describe('一轮进行中的实时上下文（含自动压缩）', () => {
  // 复现：压缩前上一轮落盘 372K；本轮中途自动压缩，之后每次请求上报 ~60–76K
  const big = 'x'.repeat(4 * 40_000); // ≈ 40K token 的工具输出
  const msgs: ConvMessage[] = [
    { id: 'u1', role: 'user', text: '旧问题', at: 1 },
    {
      id: 'a1',
      role: 'assistant',
      text: '旧回答',
      at: 2,
      trace: [
        { type: 'tool', name: 'Read', status: 'done', output: big },
        { type: 'tool', name: 'Read', status: 'done', output: big },
        { type: 'tool', name: 'Read', status: 'done', output: big },
      ],
      usage: { contextTokens: 372_301 },
    },
    { id: 'u2', role: 'user', text: '拉取 merge/202610 分支', at: 3 },
  ];

  it('没有实时值时仍是上一轮落盘的值（旧行为，环会停在 372K）', () => {
    expect(estimateContext(msgs, labels, { windowSize: 1_000_000 }).used).toBeGreaterThan(372_000);
  });

  it('实时值覆盖上一轮的旧值；分类只算最近的消息，不超过总量', () => {
    const est = estimateContext(withLiveContext(msgs, { tokens: 75_684 }), labels, {
      windowSize: 1_000_000,
    });
    expect(est).toMatchObject({ used: 75_684, basis: 'actual' });
    const sum = est.categories.reduce((n, c) => n + c.tokens, 0);
    expect(sum).toBeLessThanOrEqual(75_684 + 4);
    expect(est.categories.find((c) => c.key === 'system')).toBeUndefined();
  });

  it('刚压缩、大小未知：丢弃旧值回退估算', () => {
    const est = estimateContext(withLiveContext(msgs, { tokens: null }), labels, {
      windowSize: 1_000_000,
    });
    expect(est.basis).toBe('estimate');
    expect(est.used).toBeLessThan(372_301);
  });

  it('Codex / Gemini 实时上报的窗口优先于经验表', () => {
    const live = withLiveContext(msgs, { tokens: 50_000, window: 272_000 });
    expect(contextWindowFor('codex', reportedContextWindow(live))).toEqual({
      size: 272_000,
      source: 'reported',
    });
  });

  it('没有 live 时消息原样返回', () => {
    expect(withLiveContext(msgs, undefined)).toBe(msgs);
  });
});

describe('压缩摘要之后（重启后没有实时值）', () => {
  const msgs: ConvMessage[] = [
    { id: 'u1', role: 'user', text: '按顺序修复', at: 1 },
    {
      id: 'a1',
      role: 'assistant',
      text: 'P0 和 P1 都按顺序修完了',
      at: 2,
      usage: { contextTokens: 372_301, model: 'claude-opus-5-5' },
    },
    {
      id: 'u2',
      role: 'user',
      text: 'This session is being continued from a previous conversation that ran out of context. Summary…',
      at: 3,
    },
  ];

  it('压缩前的真实用量作废，只估算摘要及之后', () => {
    const est = estimateContext(msgs, labels, { windowSize: 1_000_000 });
    expect(est.basis).toBe('estimate');
    expect(est.used).toBeLessThan(1000);
  });

  it('摘要之后又有真实用量 / CLI 记录的值时以它为准', () => {
    const est = estimateContext(withLiveContext(msgs, { tokens: 248_542 }), labels, {
      windowSize: 1_000_000,
    });
    expect(est).toMatchObject({ used: 248_542, basis: 'actual' });
  });

  it('CLI 会话记录给了分项时直接用（总和 = 总量），不再凑「系统提示」', () => {
    const breakdown = {
      system: 58_805,
      user: 12_613,
      assistant: 8_058,
      tools: 175_156,
      thinking: 492,
    };
    const est = estimateContext(withLiveContext(msgs, { tokens: 255_124, breakdown }), labels, {
      windowSize: 1_000_000,
    });
    expect(est.used).toBe(255_124);
    expect(Object.fromEntries(est.categories.map((c) => [c.key, c.tokens]))).toEqual(breakdown);
  });

  it('模型名从用量里取，标签没指定模型也能查到 1M 窗口', () => {
    expect(reportedModel(msgs)).toBe('claude-opus-5-5');
    expect(contextWindowFor(reportedModel(msgs)).size).toBe(1_000_000);
  });
});
