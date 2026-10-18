import { describe, expect, it } from 'vitest';

import { contextWindowFor, estimateTokens, formatTokens, formatUsd } from '../src/slash/tokens';

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
