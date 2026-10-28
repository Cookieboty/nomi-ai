/**
 * 回归：macOS「开发模式」交互后菜单栏图标 / App 菜单消失。
 * 根因：灵动岛窗口的 setVisibleOnAllWorkspaces 默认会转换进程类型（Foreground ↔ UIElement）。
 * 同时守住托盘本身：引用不丢、图标非空、被销毁后可重建。
 */
const trayInstances: FakeTray[] = [];
class FakeTray {
  destroyed = false;
  image: unknown;
  setImage = jest.fn((img: unknown) => {
    this.image = img;
  });
  setToolTip = jest.fn();
  setContextMenu = jest.fn();
  constructor(img: unknown) {
    this.image = img;
    trayInstances.push(this);
  }
  destroy() {
    this.destroyed = true;
  }
  isDestroyed() {
    return this.destroyed;
  }
}
const fakeImage = (empty = false) => ({
  isEmpty: () => empty,
  setTemplateImage: jest.fn(),
  resize: () => fakeImage(empty),
});
let trayIconCb: ((img: unknown) => void) | null = null;
let emptyAsset = false;

jest.mock('electron', () => ({
  Tray: FakeTray,
  Menu: { buildFromTemplate: (t: unknown) => t },
  nativeImage: { createFromPath: () => fakeImage(emptyAsset) },
}));
jest.mock('../../../src/core/appIcon', () => ({
  assetsDir: () => '/nope',
  iconImage: () => fakeImage(false),
  onTrayIcon: (cb: (img: unknown) => void) => {
    trayIconCb = cb;
    return () => {
      trayIconCb = null;
    };
  },
}));
jest.mock('@nomi-ai/core/ai/mascotCommand', () => ({ broadcastMascotCommand: jest.fn() }));

import { TrayManager } from '../../../src/core/TrayManager';
import { applyIslandWorkspaceBehavior } from '../../../src/island/IslandService';

const providers = {
  state: () => ({ providers: [], envProviders: [], effectiveProviderId: null, overrideId: null }),
  onChange: () => () => undefined,
};
const make = () =>
  new TrayManager({
    providers: providers as never,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    openChat: jest.fn(),
    openProviderPanel: jest.fn(),
    quit: jest.fn(),
  });

describe('island window must not transform the macOS process type', () => {
  it('passes skipTransformProcessType with visibleOnFullScreen', () => {
    const win = { setVisibleOnAllWorkspaces: jest.fn() };
    applyIslandWorkspaceBehavior(win);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  });
});

describe('TrayManager lifecycle', () => {
  beforeEach(() => {
    trayInstances.length = 0;
    emptyAsset = false;
    delete process.env.IG_DISABLE_TRAY;
  });

  it('keeps one live tray with a non-empty icon', () => {
    const m = make();
    m.start();
    m.start();
    expect(trayInstances).toHaveLength(1);
    expect(m.isAlive()).toBe(true);
    expect((trayInstances[0]!.image as { isEmpty(): boolean }).isEmpty()).toBe(false);
  });

  it('never applies an empty image from icon-variant events', () => {
    make().start();
    trayIconCb?.(fakeImage(true));
    expect(trayInstances[0]!.setImage).not.toHaveBeenCalled();
    trayIconCb?.(fakeImage(false));
    expect(trayInstances[0]!.setImage).toHaveBeenCalledTimes(1);
  });

  it('recreates the tray when it was destroyed behind our back (ensureAlive)', () => {
    const m = make();
    m.start();
    expect(m.ensureAlive()).toBe(false);
    trayInstances[0]!.destroy();
    expect(m.isAlive()).toBe(false);
    expect(m.ensureAlive()).toBe(true);
    expect(trayInstances).toHaveLength(2);
    expect(m.isAlive()).toBe(true);
  });

  it('falls back to another icon when the template asset is empty', () => {
    emptyAsset = true;
    const m = make();
    m.start();
    expect(m.isAlive()).toBe(true);
  });

  it('dispose destroys the tray and ensureAlive afterwards recreates nothing twice', () => {
    const m = make();
    m.start();
    m.dispose();
    expect(trayInstances[0]!.destroyed).toBe(true);
    expect(m.isAlive()).toBe(false);
  });
});
