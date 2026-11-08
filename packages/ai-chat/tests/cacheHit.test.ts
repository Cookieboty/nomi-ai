import { describe, expect, it } from 'vitest';

import { cacheHitRate, formatHitRate } from '../src/utils/cacheHit';

describe('cacheHitRate', () => {
  it('cache read over all input; unknown when there is no input or no cache data', () => {
    expect(cacheHitRate(10_000, 7_500)).toBe(0.75);
    expect(cacheHitRate(10_000, 0)).toBe(0);
    expect(cacheHitRate(0, 10)).toBeUndefined();
    expect(cacheHitRate(undefined, 10)).toBeUndefined();
    expect(cacheHitRate(100, undefined)).toBeUndefined();
    // 口径异常（缓存读大于输入）：封顶 100%
    expect(cacheHitRate(100, 300)).toBe(1);
    expect(formatHitRate(0.756)).toBe('76%');
  });
});
