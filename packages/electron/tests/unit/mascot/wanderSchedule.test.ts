/**
 * E9 free-place flake: after 「立即走一走」, nextWanderAt stayed at the startup
 * +15s mark. Once that elapsed, the next idle tick (e.g. free-place dragEnd)
 * immediately re-entered walking and the e2e assert saw mode === 'walking'.
 */
import type { BrowserWindow } from 'electron';

const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
const listeners = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
jest.mock('electron', () => ({
  ipcMain: {
    on: jest.fn((ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) =>
      listeners.set(ch, fn),
    ),
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
    getCursorScreenPoint: jest.fn(() => ({ x: 960, y: 500 })),
  },
}));

import { mascotWindowSize } from '../../../src/mascot/mascotSize';
import { MascotWindowController } from '../../../src/mascot/MascotWindowController';

function setup(Ctrl: typeof MascotWindowController = MascotWindowController) {
  const size = mascotWindowSize(1);
  const b = { x: 700, y: 1040 - size.height, ...size };
  const wc = {
    send: jest.fn(),
    setVisualZoomLevelLimits: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  };
  const win = {
    webContents: wc,
    getPosition: () => [b.x, b.y],
    getSize: () => [b.width, b.height],
    getBounds: () => ({ ...b }),
    setBounds: jest.fn((n: typeof b) => Object.assign(b, n)),
    setPosition: jest.fn((x: number, y: number) => Object.assign(b, { x, y })),
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
  // Deterministic rnd → scheduleNextWander always adds 20s + 0.5*40s = 40s
  const c = new Ctrl(
    win as unknown as BrowserWindow,
    { info: jest.fn(), warn: jest.fn() },
    () => 0.5,
    { get: () => 1, save: () => undefined },
  );
  c.start();
  const emit = (ch: string, ...a: unknown[]) => listeners.get(ch)!({ sender: wc }, ...a);
  const w0 = mascotWindowSize(1);
  emit('mascot:geometry', {
    left: 150,
    right: 390,
    top: 140,
    bottom: 570,
    vw: w0.width,
    vh: w0.height,
  });
  return { b, c, emit, wc };
}

describe('MascotWindowController · drag and wander scheduling', () => {
  beforeEach(() => {
    handlers.clear();
    listeners.clear();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('moves immediately when a drag point arrives instead of waiting for the next tick', () => {
    const s = setup();
    const startX = s.b.x + 40;
    const startY = s.b.y + 40;
    s.emit('mascot:drag-start', startX, startY);
    const before = { x: s.b.x, y: s.b.y };

    s.emit('mascot:drag-move', startX + 90, startY - 55);

    expect(s.b.x).toBe(before.x + 90);
    expect(s.b.y).toBe(before.y - 55);
  });

  it('applies every drag sample within one frame (no 16.7ms throttle)', () => {
    const s = setup();
    const startX = s.b.x + 40;
    const startY = s.b.y + 40;
    s.emit('mascot:drag-start', startX, startY);
    const before = { x: s.b.x, y: s.b.y };
    s.emit('mascot:drag-move', startX + 10, startY);
    s.emit('mascot:drag-move', startX + 20, startY);
    expect(s.b.x).toBe(before.x + 20);
    expect(s.b.y).toBe(before.y);
  });

  it('on Windows follows the OS cursor instead of the renderer screenX/Y', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      let Ctrl!: typeof MascotWindowController;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        Ctrl = require('../../../src/mascot/MascotWindowController').MascotWindowController;
      });
      const { screen } = jest.requireMock('electron') as {
        screen: { getCursorScreenPoint: jest.Mock };
      };
      const s = setup(Ctrl);
      const startX = s.b.x + 40;
      const startY = s.b.y + 40;
      s.emit('mascot:drag-start', startX, startY);
      const before = { x: s.b.x, y: s.b.y };
      screen.getCursorScreenPoint.mockReturnValueOnce({ x: startX + 30, y: startY - 20 });
      // Stale renderer coordinates (window origin lagging behind the move) are ignored.
      s.emit('mascot:drag-move', startX + 999, startY + 999);
      expect(s.b.x).toBe(before.x + 30);
      expect(s.b.y).toBe(before.y - 20);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('wander-now pushes nextWanderAt so free-place idle is not stolen after the startup 15s', () => {
    const s = setup();
    s.emit('mascot:interaction-config', { wander: true, gravity: false });
    // Past the startup nextWanderAt (+15s) — without the fix, the next idle tick would walk.
    jest.advanceTimersByTime(16_000);
    expect(s.c.snapshot().body.mode).toBe('walking'); // auto-wander fired once
    // Finish the walk by disabling wander (forces idle) then re-enable and manual wander-now.
    s.emit('mascot:interaction-config', { wander: false });
    expect(s.c.snapshot().body.mode).toBe('idle');
    s.emit('mascot:interaction-config', { wander: true });
    s.emit('mascot:wander-now');
    expect(s.c.snapshot().body.mode).toBe('walking');

    // Simulate arrive: turn wander off mid-walk → idle, then free-place style dragEnd path.
    s.emit('mascot:interaction-config', { wander: false });
    expect(s.c.snapshot().body.mode).toBe('idle');
    s.emit('mascot:interaction-config', { wander: true, gravity: false });

    // Drag up and release (free place). dragEnd must leave mode idle and defer auto-wander.
    const gx = s.b.x + s.b.width / 2;
    const gy = s.b.y + s.b.height / 2;
    s.emit('mascot:drag-start', gx, gy);
    expect(s.c.snapshot().body.mode).toBe('held');
    s.emit('mascot:drag-move', gx, gy - 200);
    jest.advanceTimersByTime(50);
    s.emit('mascot:drag-end');
    expect(s.c.snapshot().body.mode).toBe('idle');

    // Several seconds of ticks must stay idle (next wander is 20–60s out).
    jest.advanceTimersByTime(5_000);
    expect(s.c.snapshot().body.mode).toBe('idle');
  });
});
