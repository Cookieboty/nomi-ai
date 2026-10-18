import { describe, expect, it } from 'vitest';

import { hasLangFence, hasOpenFence } from '../src/utils/markdown';
import {
  MAX_STREAM_INTERVAL_MS,
  baseIntervalMs,
  lengthFactor,
  streamRenderIntervalMs,
} from '../src/utils/streamPolicy';

describe('streamRenderIntervalMs（流式渲染频率分档）', () => {
  it('核数越多间隔越小', () => {
    const at = (c: number) => baseIntervalMs(c);
    expect(at(2)).toBeGreaterThanOrEqual(at(4));
    expect(at(4)).toBeGreaterThan(at(8));
    expect(at(8)).toBeGreaterThan(at(12));
    expect(at(12)).toBeGreaterThan(at(16));
    expect(at(0)).toBe(110);
    expect(at(Number.NaN)).toBe(110);
  });

  it('正文越长间隔越大，且不超过上限', () => {
    expect(lengthFactor(100)).toBe(1);
    expect(lengthFactor(2000)).toBeGreaterThan(lengthFactor(1999));
    expect(lengthFactor(8000)).toBeGreaterThan(lengthFactor(7999));
    expect(lengthFactor(20000)).toBeGreaterThan(lengthFactor(19999));
    for (const cores of [1, 4, 8, 12, 32])
      for (const len of [0, 500, 5000, 50000, 1e6])
        expect(streamRenderIntervalMs(len, cores)).toBeLessThanOrEqual(MAX_STREAM_INTERVAL_MS);
  });

  it('典型场景：8 核、8000 字符的代码块 ≥ 110ms（实测 110ms 约占 7% 单核，16ms 约 50%）', () => {
    expect(streamRenderIntervalMs(8000, 8)).toBeGreaterThanOrEqual(110);
    expect(streamRenderIntervalMs(100, 8)).toBe(110);
    expect(streamRenderIntervalMs(100, 16)).toBeLessThan(110);
    expect(streamRenderIntervalMs(30000, 2)).toBe(MAX_STREAM_INTERVAL_MS);
  });
});

describe('hasOpenFence / hasLangFence', () => {
  it('识别未闭合围栏', () => {
    expect(hasOpenFence('文字\n\n```ts\nconst a = 1;')).toBe(true);
    expect(hasOpenFence('```ts\nconst a = 1;\n```')).toBe(false);
    expect(hasOpenFence('```ts\nx\n```\n\n```py\nprint(1)')).toBe(true);
    expect(hasOpenFence('没有代码')).toBe(false);
    expect(hasOpenFence('~~~\nabc')).toBe(true);
  });

  it('更长的围栏不会被较短的闭合行提前关掉；缩进 4 格以上不是围栏', () => {
    expect(hasOpenFence('````md\n```\ninner\n```')).toBe(true);
    expect(hasOpenFence('````md\n```\ninner\n```\n````')).toBe(false);
    expect(hasOpenFence('    ```ts\n    x')).toBe(false);
  });

  it('hasLangFence 只在出现带语言标记的围栏时为真', () => {
    expect(hasLangFence('```ts\nx\n```')).toBe(true);
    expect(hasLangFence('~~~python\nx')).toBe(true);
    expect(hasLangFence('```\nplain\n```')).toBe(false);
    expect(hasLangFence('行内 `code` 不算')).toBe(false);
  });
});
