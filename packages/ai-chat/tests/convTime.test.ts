import { describe, expect, it } from 'vitest';

import {
  formatCost,
  formatFullTime,
  formatTokens,
  thoughtLabel,
  timeLabels,
  turnSummary,
} from '../src/utils/convTime';

const at = (h: number, m: number, s = 0) => new Date(2026, 9, 16, h, m, s).getTime();

describe('timeLabels：相邻消息按分钟合并', () => {
  it('同一分钟只在第一条显示；换分钟再显示；跨天带日期', () => {
    const now = at(18, 0);
    const msgs = [
      { id: 'a', at: at(14, 3, 5) },
      { id: 'b', at: at(14, 3, 40) },
      { id: 'c', at: at(14, 4, 1) },
      { id: 'd', at: new Date(2026, 9, 15, 23, 59).getTime() },
    ];
    const l = timeLabels(msgs, now);
    expect(l.get('a')).toBe('14:03');
    expect(l.has('b')).toBe(false);
    expect(l.get('c')).toBe('14:04');
    expect(l.get('d')).toBe('10-15 23:59');
  });

  it('完整时间精确到秒', () => {
    expect(formatFullTime(at(9, 5, 7))).toBe('2026-10-16 09:05:07');
  });
});

describe('用量 / 耗时摘要', () => {
  it('token 与费用格式', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(12_345)).toBe('12k');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatCost(0.0004)).toBe('<$0.01');
    expect(formatCost(0.0432)).toBe('$0.043');
    expect(formatCost(2.5)).toBe('$2.50');
  });

  it('有数据才出现；全无则 null', () => {
    expect(turnSummary({})).toBeNull();
    const s = turnSummary({
      durationMs: 72_000,
      usage: { inputTokens: 12_000, outputTokens: 800, costUsd: 0.05 },
    })!;
    expect(s.duration).toBe('1m 12s');
    expect(s.tokens).toContain('12k');
    expect(s.tokens).toContain('800');
    expect(s.cost).toBe('$0.05');
    expect(turnSummary({ durationMs: 3000 })).toEqual({ duration: '3.0s' });
  });

  it('已思考 N 秒', () => {
    expect(thoughtLabel(12_400)).toBe('已思考 12 秒');
    expect(thoughtLabel(200)).toBe('已思考 1 秒');
    expect(thoughtLabel(72_000)).toBe('已思考 1 分 12 秒');
    expect(thoughtLabel(undefined)).toBe('已思考');
  });
});
