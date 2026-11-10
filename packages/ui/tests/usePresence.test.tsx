// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_MS, usePresence } from '../src/usePresence';

const stubMotion = (reduce: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    (q: string) =>
      ({
        matches: q.includes('no-preference') ? !reduce : reduce,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePresence', () => {
  it('keeps the last value while the exit animation plays, then unmounts', () => {
    vi.useFakeTimers();
    stubMotion(false);
    const a = { x: 1 };
    const { result, rerender } = renderHook(({ v }) => usePresence(v), {
      initialProps: { v: a as typeof a | null },
    });
    expect(result.current).toEqual({ value: a, closing: false });
    rerender({ v: null });
    expect(result.current).toEqual({ value: a, closing: true });
    // 收起途中又打开：直接回到打开
    rerender({ v: a });
    expect(result.current).toEqual({ value: a, closing: false });
    rerender({ v: null });
    act(() => vi.advanceTimersByTime(EXIT_MS));
    expect(result.current).toEqual({ value: null, closing: false });
  });

  it('unmounts at once when reduced motion is on', () => {
    stubMotion(true);
    const { result, rerender } = renderHook(({ v }) => usePresence(v), {
      initialProps: { v: true as boolean },
    });
    rerender({ v: false });
    expect(result.current).toEqual({ value: null, closing: false });
  });
});
