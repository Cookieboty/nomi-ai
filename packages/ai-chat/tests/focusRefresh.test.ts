// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { onWindowFocus } from '../src/utils/focusRefresh';

afterEach(() => vi.useRealTimers());

describe('onWindowFocus', () => {
  it('reruns on focus at most once per interval and stops after unsubscribing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const fn = vi.fn();
    const off = onWindowFocus(fn, 5000);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    expect(fn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(104_000);
    window.dispatchEvent(new Event('focus'));
    expect(fn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(105_001);
    window.dispatchEvent(new Event('focus'));
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    vi.setSystemTime(200_000);
    window.dispatchEvent(new Event('focus'));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
