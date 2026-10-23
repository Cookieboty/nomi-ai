import { describe, expect, it } from 'vitest';

import {
  contextTokensOf,
  contextWindowFor,
  estimateContext,
  estimateTokens,
  formatTokens,
  formatUsd,
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

describe('contextTokensOf / estimateContext 防爆窗', () => {
  it('OpenAI 风格 cache≤input 不重复计', () => {
    expect(contextTokensOf({ inputTokens: 1000, cacheReadTokens: 900, outputTokens: 50 })).toBe(
      1050,
    );
  });
  it('Anthropic 风格 input 与 cache 互斥则相加', () => {
    expect(contextTokensOf({ inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 500 })).toBe(
      10_500,
    );
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
        usage: { inputTokens: 7_000_000, cacheReadTokens: 7_000_000, outputTokens: 100 },
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
        usage: { inputTokens: 1200, cacheReadTokens: 800, outputTokens: 40 },
      },
    ];
    // OpenAI: cache≤input → 1200+40
    const est = estimateContext(msgs, labels, { windowSize: 128_000 });
    expect(est.basis).toBe('actual');
    expect(est.used).toBe(1240);
  });
});
