/**
 * #64 · E23（Windows）脚底锚点偏移 44px：缩放后，渲染进程按「旧窗口尺寸」量出的包围盒
 * 晚于主进程按比例推算的新包围盒到达，把它覆盖回旧值。主进程按上报里的视口尺寸丢弃这类旧测量。
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
    getCursorScreenPoint: jest.fn(() => ({ x: 0, y: 0 })),
  },
}));

import { mascotWindowSize } from '../../../src/mascot/mascotSize';
import {
  isStaleGeometry,
  MascotWindowController,
} from '../../../src/mascot/MascotWindowController';

function setup(scale = 0.5) {
  const size = mascotWindowSize(scale);
  const b = { x: 800, y: 1040 - size.height, ...size };
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
  const c = new MascotWindowController(
    win as unknown as BrowserWindow,
    { info: jest.fn(), warn: jest.fn() },
    () => 0.5,
    { get: () => scale, save: () => undefined },
  );
  c.start();
  const geometry = (box: Record<string, number>) =>
    listeners.get('mascot:geometry')!({ sender: wc }, box);
  const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({ sender: wc }, ...a);
  return { b, c, geometry, call };
}

describe('MascotWindowController · stale geometry after a resize', () => {
  beforeEach(() => {
    handlers.clear();
    listeners.clear();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it('isStaleGeometry: only reports measured at the pre-resize size are stale', () => {
    const cur = { width: 628, height: 675 };
    const old = { width: 540, height: 580 };
    expect(isStaleGeometry(540, 580, cur, old)).toBe(true);
    expect(isStaleGeometry(541, 579, cur, old)).toBe(true); // 1px 取整容差
    expect(isStaleGeometry(628, 675, cur, old)).toBe(false);
    expect(isStaleGeometry(700, 700, cur, old)).toBe(false); // 未知尺寸：不猜，照常接受
    expect(isStaleGeometry(undefined, undefined, cur, old)).toBe(false); // 旧渲染进程不带尺寸
    expect(isStaleGeometry(540, 580, cur, null)).toBe(false); // 还没缩放过
  });

  it('a box measured before the resize does not overwrite the projected box', async () => {
    const s = setup(1);
    const w0 = mascotWindowSize(1);
    // 1.0 时角色居中：窗口宽 540，包围盒中心 270
    s.geometry({ left: 150, right: 390, top: 140, bottom: 570, vw: w0.width, vh: w0.height });
    const feet = () => {
      const box = s.c.snapshot().box!;
      return { x: s.b.x + (box.left + box.right) / 2, y: s.b.y + box.bottom };
    };
    const before = feet();

    await s.call('mascot:scale-set', 1.2);
    const w1 = mascotWindowSize(1.2);
    expect([s.b.width, s.b.height]).toEqual([w1.width, w1.height]);
    const projected = s.c.snapshot().box!;
    expect(Math.abs(feet().x - before.x)).toBeLessThanOrEqual(1);

    // 缩放前量的那一份（视口仍是旧尺寸）晚到：丢弃
    s.geometry({ left: 150, right: 390, top: 140, bottom: 570, vw: w0.width, vh: w0.height });
    expect(s.c.snapshot().box).toEqual(projected);
    expect(Math.abs(feet().x - before.x)).toBeLessThanOrEqual(1);

    // 按新尺寸量的照常生效
    s.geometry({ left: 172, right: 460, top: 154, bottom: 670, vw: w1.width, vh: w1.height });
    expect(s.c.snapshot().box).toMatchObject({ left: 172, right: 460, bottom: 670 });

    // 不带视口尺寸的上报（兼容）照常生效
    s.geometry({ left: 170, right: 462, top: 150, bottom: 660 });
    expect(s.c.snapshot().box).toMatchObject({ left: 170, right: 462, bottom: 660 });
    s.c.dispose();
  });
});
