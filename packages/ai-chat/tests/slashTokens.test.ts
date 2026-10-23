import { describe, expect, it } from 'vitest';

import {
  contextWindowFor,
  estimateContext,
  estimateTokens,
  formatTokens,
  formatUsd,
  reportedContextWindow,
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
