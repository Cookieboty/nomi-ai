import type { BrowserWindow } from 'electron';

const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
jest.mock('electron', () => ({
  ipcMain: {
    on: jest.fn(),
    handle: jest.fn((ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) =>
      handlers.set(ch, fn),
    ),
    removeHandler: jest.fn((ch: string) => handlers.delete(ch)),
    removeListener: jest.fn(),
  },
  screen: {
    on: jest.fn(),
    removeListener: jest.fn(),
    getAllDisplays: jest.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }]),
    getCursorScreenPoint: jest.fn(() => ({ x: 0, y: 0 })),
  },
}));

import { MASCOT_PAD, mascotWindowSize } from '../../../src/mascot/mascotSize';
import { MascotWindowController } from '../../../src/mascot/MascotWindowController';

function fakeWindow(scale: number, x: number, y: number) {
  const size = mascotWindowSize(scale);
  const b = { x, y, ...size };
  const sent: Array<[string, unknown]> = [];
  const wc = { send: (ch: string, p: unknown) => sent.push([ch, p]) };
  const win = {
    webContents: wc,
    getPosition: () => [b.x, b.y],
    getSize: () => [b.width, b.height],
    getBounds: () => ({ ...b }),
    setBounds: jest.fn((n: typeof b) => Object.assign(b, n)),
    setPosition: jest.fn(),
    isResizable: () => false,
    setResizable: jest.fn(),
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    on: jest.fn(),
    off: jest.fn(),
    setIgnoreMouseEvents: jest.fn(),
    setShape: jest.fn(),
  };
  return { win: win as unknown as BrowserWindow, raw: win, b, sent, wc };
}

const logger = { info: jest.fn(), warn: jest.fn() };
const call = (ch: string, sender: unknown, ...a: unknown[]) => handlers.get(ch)!({ sender }, ...a);

describe('MascotWindowController scale IPC', () => {
  beforeEach(() => {
    handlers.clear();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  function setup(scale = 0.5) {
    const f = fakeWindow(scale, 1000, 1040 - mascotWindowSize(scale).height);
    const saved: number[] = [];
    const changed: unknown[] = [];
    const c = new MascotWindowController(f.win, logger, Math.random, {
      get: () => scale,
      save: (s) => saved.push(s),
      changed: (s) => changed.push(s),
    });
    c.start();
    return { ...f, c, saved, changed };
  }

  it('reports state, resizes around the feet, persists and notifies', async () => {
    const s = setup();
    const st0 = (await call('mascot:scale-get', s.wc)) as { scale: number; max: number };
    expect(st0).toMatchObject({ scale: 0.5, min: 0.3, max: 1.5, hardMax: 1.5, default: 0.5 });
    const feetBefore = { x: s.b.x + s.b.width / 2, y: s.b.y + s.b.height };

    const st = (await call('mascot:scale-step', s.wc, 1)) as { scale: number };
    expect(st.scale).toBe(0.6);
    expect(s.b.width).toBe(mascotWindowSize(0.6).width);
    expect(s.b.height).toBe(mascotWindowSize(0.6).height);
    expect(Math.abs(s.b.x + s.b.width / 2 - feetBefore.x)).toBeLessThanOrEqual(1);
    expect(s.b.y + s.b.height).toBe(feetBefore.y);
    expect(s.saved).toEqual([0.6]);
    expect(s.changed).toHaveLength(1);
    expect(s.sent.some(([ch]) => ch === 'mascot:scale-changed')).toBe(true);
    s.c.dispose();
  });

  it('wheel / set / reset, clamped; junk is ignored; other senders are refused', async () => {
    const s = setup();
    expect(
      ((await call('mascot:scale-wheel', s.wc, -100, 0)) as { scale: number }).scale,
    ).toBeGreaterThan(0.5);
    expect(((await call('mascot:scale-set', s.wc, 99)) as { scale: number }).scale).toBe(1.5);
    expect(s.b.y).toBeGreaterThanOrEqual(0);
    expect(s.b.y + s.b.height).toBeLessThanOrEqual(1040);
    expect(((await call('mascot:scale-set', s.wc, 0)) as { scale: number }).scale).toBe(0.3);
    expect(((await call('mascot:scale-set', s.wc, 'x')) as { scale: number }).scale).toBe(0.3);
    expect(((await call('mascot:scale-reset', s.wc)) as { scale: number }).scale).toBe(0.5);
    const n = s.saved.length;
    // an unknown webContents cannot resize the mascot
    const st = (await call('mascot:scale-set', { other: true }, 1)) as { scale: number };
    expect(st.scale).toBe(0.5);
    expect(s.saved).toHaveLength(n);
    s.c.dispose();
  });

  it('keeps the physics body and the pointer-drag offset on the moved window', async () => {
    const s = setup();
    await call('mascot:scale-set', s.wc, 1.2);
    const snap = s.c.snapshot();
    expect(snap.body.x).toBe(s.b.x);
    expect(snap.body.y).toBe(s.b.y);
    // body and box coordinates are scaled together (box stays inside the new window)
    s.c.dispose();
  });

  it('small displays: the cap follows the work area and never exceeds it', async () => {
    const { screen } = jest.requireMock('electron') as { screen: { getAllDisplays: jest.Mock } };
    screen.getAllDisplays.mockReturnValue([{ workArea: { x: 0, y: 0, width: 1366, height: 728 } }]);
    const s = setup();
    const st = (await call('mascot:scale-set', s.wc, 1.5)) as { scale: number; max: number };
    expect(st.max).toBeLessThan(1.5);
    expect(st.scale).toBe(st.max);
    expect(s.b.height).toBeLessThanOrEqual(728);
    expect(MASCOT_PAD.top).toBe(130);
    s.c.dispose();
    screen.getAllDisplays.mockReturnValue([
      { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    ]);
  });
});
