// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hostScreen,
  resetHostScreen,
  setHostScreen,
  subscribeHostScreen,
} from '../../src/mascot/hostScreen';

afterEach(() => resetHostScreen());

describe('hostScreen', () => {
  it('falls back to window.screen until the kernel pushes a position', () => {
    expect(hostScreen().winX).toBe(window.screenX);
    setHostScreen({ winX: 1500, winY: 40, availLeft: 0, availWidth: 1728 });
    expect(hostScreen()).toEqual({ winX: 1500, winY: 40, availLeft: 0, availWidth: 1728 });
  });

  it('notifies only when the position or work area changes', () => {
    const fn = vi.fn();
    subscribeHostScreen(fn);
    const s = { winX: 10, winY: 20, availLeft: 0, availWidth: 1440 };
    setHostScreen(s);
    setHostScreen({ ...s });
    expect(fn).toHaveBeenCalledTimes(1);
    setHostScreen({ ...s, winX: 1300 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
