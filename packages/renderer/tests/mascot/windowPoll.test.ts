// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startWindowPoll } from '@/mascot/windowPoll';

describe('startWindowPoll', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('recomputes when the window moves, skips unchanged ticks but forces a periodic check', () => {
    const compute = vi.fn();
    const stop = startWindowPoll(compute, 100, { forceEvery: 5 });
    vi.advanceTimersByTime(400); // 4 ticks, nothing moved
    expect(compute).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100); // 5th tick: forced
    expect(compute).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, 'screenX', { value: 321, configurable: true });
    vi.advanceTimersByTime(100);
    expect(compute).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(1000);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('does nothing while inactive or while the page is hidden', () => {
    const compute = vi.fn();
    let active = false;
    const stop = startWindowPoll(compute, 100, { active: () => active, forceEvery: 1 });
    vi.advanceTimersByTime(500);
    expect(compute).not.toHaveBeenCalled();
    active = true;
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    vi.advanceTimersByTime(500);
    expect(compute).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(compute).toHaveBeenCalledTimes(1);
    hidden.mockRestore();
    stop();
  });
});
