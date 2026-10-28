import type { BrowserWindow, Rectangle } from 'electron';

import { moveWindowTo, setWindowBounds } from '../../../src/host/windowBounds';

function fakeWin(initial: Rectangle) {
  const b = { ...initial };
  const calls = {
    setBounds: [] as Rectangle[],
    setPosition: [] as Array<[number, number]>,
    setResizable: [] as boolean[],
  };
  let resizable = false;
  const win = {
    getBounds: () => ({ ...b }),
    setBounds: (n: Rectangle) => {
      calls.setBounds.push({ ...n });
      Object.assign(b, n);
    },
    setPosition: (x: number, y: number) => {
      calls.setPosition.push([x, y]);
      b.x = x;
      b.y = y;
    },
    isResizable: () => resizable,
    setResizable: (v: boolean) => {
      calls.setResizable.push(v);
      resizable = v;
    },
  };
  return { win: win as unknown as BrowserWindow, b, calls };
}

describe('setWindowBounds', () => {
  it('unlocks a non-resizable Windows window, corrects once, then relocks', () => {
    const { win, calls } = fakeWin({ x: 10, y: 20, width: 100, height: 200 });
    setWindowBounds(win, { x: 30, y: 40, width: 100, height: 200 }, 'win32');
    expect(calls.setResizable).toEqual([true, false]);
    expect(calls.setBounds).toHaveLength(1);
    expect(calls.setBounds[0]).toEqual({ x: 30, y: 40, width: 100, height: 200 });
  });

  it('skips setResizable when unlockSize is false', () => {
    const { win, calls } = fakeWin({ x: 10, y: 20, width: 100, height: 200 });
    setWindowBounds(win, { x: 50, y: 60, width: 100, height: 200 }, 'win32', {
      unlockSize: false,
    });
    expect(calls.setResizable).toEqual([]);
    expect(calls.setBounds).toHaveLength(1);
  });
});

describe('moveWindowTo', () => {
  it('uses setPosition on non-Windows', () => {
    const { win, calls } = fakeWin({ x: 0, y: 0, width: 100, height: 200 });
    moveWindowTo(win, 12, 34, { width: 100, height: 200 }, 'linux');
    expect(calls.setPosition).toEqual([[12, 34]]);
    expect(calls.setBounds).toHaveLength(0);
    expect(calls.setResizable).toEqual([]);
  });

  it('does not flap setResizable across many position-only Windows moves (drag path)', () => {
    const size = { width: 320, height: 640 };
    const { win, calls, b } = fakeWin({ x: 100, y: 200, ...size });
    for (let i = 0; i < 120; i++) {
      moveWindowTo(win, 100 + i, 200 + i, size, 'win32');
    }
    expect(calls.setResizable).toEqual([]);
    expect(calls.setBounds).toHaveLength(120);
    expect(b).toMatchObject({ x: 219, y: 319, ...size });
    expect(calls.setBounds.every((n) => n.width === size.width && n.height === size.height)).toBe(
      true,
    );
  });

  it('unlocks and corrects once when Windows size has drifted (DPI leak)', () => {
    const want = { width: 320, height: 640 };
    const { win, calls, b } = fakeWin({ x: 10, y: 20, width: 330, height: 650 });
    moveWindowTo(win, 40, 50, want, 'win32');
    expect(calls.setResizable).toEqual([true, false]);
    expect(b).toMatchObject({ x: 40, y: 50, ...want });
    // subsequent moves stay light
    moveWindowTo(win, 41, 51, want, 'win32');
    expect(calls.setResizable).toEqual([true, false]);
    expect(b).toMatchObject({ x: 41, y: 51, ...want });
  });

  it('skips synchronous size readback for verified drag moves', () => {
    const { win, calls, b } = fakeWin({ x: 10, y: 20, width: 320, height: 640 });
    moveWindowTo(win, 40, 50, { width: 320, height: 640 }, 'win32', false);
    expect(calls.setResizable).toEqual([]);
    expect(calls.setBounds).toEqual([{ x: 40, y: 50, width: 320, height: 640 }]);
    expect(b).toMatchObject({ x: 40, y: 50, width: 320, height: 640 });
  });

  it('uses position-only moves when the drag window was temporarily unlocked', () => {
    const { win, calls, b } = fakeWin({ x: 10, y: 20, width: 320, height: 640 });
    moveWindowTo(win, 40, 50, { width: 320, height: 640 }, 'win32', false, true);
    expect(calls.setPosition).toEqual([[40, 50]]);
    expect(calls.setBounds).toHaveLength(0);
    expect(b).toMatchObject({ x: 40, y: 50, width: 320, height: 640 });
  });

  it('keeps the captured native size on repeated position-only moves', () => {
    const { win, calls, b } = fakeWin({ x: 10, y: 20, width: 331, height: 356 });
    for (let i = 0; i < 50; i++) {
      moveWindowTo(win, 10 + i, 20 + i, { width: 331, height: 356 }, 'win32', false);
    }
    expect(calls.setResizable).toEqual([]);
    expect(calls.setBounds).toHaveLength(50);
    expect(b).toMatchObject({ x: 59, y: 69, width: 331, height: 356 });
  });
});
