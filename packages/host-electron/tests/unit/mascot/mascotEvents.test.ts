/**
 * 看板娘推送经内核的应用事件总线（窗口管理器建控制器时传入）：
 * 窗口控制器的大小 / 物理推送经 `events.publish` 发布契约事件；大小变化只发布一次
 * （看板娘 + 对话窗口）。没有事件总线时推送直接丢弃，不再直接发给窗口。
 */
import { createRecordingAppEvents, type AppEvents } from '@nomi-ai/core/core/appEvents';
import { mascotWindowSize } from '@nomi-ai/core/mascot/mascotSize';
import type { BrowserWindow } from 'electron';

jest.mock('electron', () => ({
  screen: {
    on: jest.fn(),
    removeListener: jest.fn(),
    getAllDisplays: jest.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }]),
    getCursorScreenPoint: jest.fn(() => ({ x: 0, y: 0 })),
  },
}));

import { MascotWindowController } from '../../../src/mascot/MascotWindowController';

function fakeWindow(scale: number, x: number, y: number) {
  const size = mascotWindowSize(scale);
  const b = { x, y, ...size };
  const sent: Array<[string, unknown]> = [];
  const win = {
    webContents: {
      send: (ch: string, p: unknown) => sent.push([ch, p]),
      setVisualZoomLevelLimits: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
    },
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
  return { win: win as unknown as BrowserWindow, raw: win, sent };
}

const logger = { info: jest.fn(), warn: jest.fn() };

describe('MascotWindowController · 应用事件总线', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
  });

  function setup(events?: AppEvents) {
    const f = fakeWindow(0.5, 1000, 1040 - mascotWindowSize(0.5).height);
    const c = new MascotWindowController(
      f.win,
      logger,
      () => 0.5,
      {
        get: () => 0.5,
        save: () => undefined,
      },
      events,
    );
    c.start();
    return { ...f, c };
  }

  it('没有事件总线时推送直接丢弃，不发给窗口', () => {
    const s = setup();
    expect(s.c.scaleStep(1).scale).toBe(0.6);
    expect(s.sent).toHaveLength(0);
    s.c.dispose();
  });

  it('经 events.publish：大小变化发布一次（看板娘 + 对话窗口），物理事件只发看板娘', () => {
    const events = createRecordingAppEvents();
    const s = setup(events);
    const st = s.c.scaleStep(1);
    expect(st.scale).toBe(0.6);
    expect(s.sent).toHaveLength(0);
    expect(events.published).toEqual([
      { event: 'mascot.scaleChanged', payload: st, surfaces: ['mascot', 'chat'] },
    ]);

    s.c.reportGeometry({ left: 10, right: 200, top: 10, bottom: 300 });
    s.c.beginDrag(1100, 900);
    s.c.moveDrag(1110, 905);
    s.c.endDrag();
    const physics = events.published.filter((p) => p.event === 'mascot.physicsEvent');
    expect(physics.map((p) => (p.payload as { type: string }).type)).toEqual(['grab', 'release']);
    for (const p of physics) expect(p.surfaces).toEqual(['mascot']);
    expect(s.sent).toHaveLength(0);
    s.c.dispose();
  });

  it('上报的公开方法忽略非法值', () => {
    const s = setup();
    expect(s.c.scaleSet('big')).toMatchObject({ scale: 0.5 });
    expect(s.c.scaleWheel(Number.NaN)).toMatchObject({ scale: 0.5 });
    expect(s.c.scaleStep(-1).scale).toBe(0.4);
    expect(s.c.scaleReset().scale).toBe(0.5);
    s.c.reportHit('yes');
    s.c.moveDrag(1, 2); // 没在拖：忽略
    expect(s.c.snapshot().body.mode).toBe('idle');
    s.c.dispose();
  });
});
