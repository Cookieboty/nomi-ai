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
jest.mock('@nomi-ai/core/ai/mascotCommand', () => ({
  sendMascotCommand: jest.fn(),
  avatarGesture: jest.fn(),
}));

import { t, tName } from '@nomi-ai/core/i18n';

import { TrayManager } from '../../../src/core/TrayManager';
import { applyIslandWorkspaceBehavior } from '../../../src/island/IslandService';

const i18n = { t, tName, onChange: () => () => undefined };
const providers = {
  state: () => ({ providers: [], envProviders: [], effectiveProviderId: null, overrideId: null }),
  onChange: () => () => undefined,
};
const make = () =>
  new TrayManager({
    providers: providers as never,
    i18n,
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

  it('rebuilds the menu with the new character name when the character changes', () => {
    let name = '诺米';
    let notify: (() => void) | null = null;
    const off = jest.fn();
    const m = new TrayManager({
      providers: providers as never,
      i18n,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      openChat: jest.fn(),
      openProviderPanel: jest.fn(),
      quit: jest.fn(),
      characterName: () => name,
      onCharacterChange: (fn) => {
        notify = fn;
        return off;
      },
    });
    m.start();
    const labels = () =>
      (trayInstances[0]!.setContextMenu.mock.calls.at(-1)![0] as Array<{ label?: string }>).map(
        (i) => i.label ?? '',
      );
    expect(labels().some((l) => l.includes('诺米'))).toBe(true);
    name = '小纸';
    notify!();
    expect(labels().some((l) => l.includes('小纸'))).toBe(true);
    expect(labels().some((l) => l.includes('诺米'))).toBe(false);
    m.dispose();
    expect(off).toHaveBeenCalled();
  });
});

describe('tray menu cache keeps model actions current (#212)', () => {
  beforeEach(() => {
    trayInstances.length = 0;
  });

  // 两个供应商同名、模型显示名也相同：菜单上是两行一样的文字，只有 ref 不同
  const provider = (id: string) => ({
    id,
    name: 'Same',
    enabled: true,
    models: [{ id: 'm', label: 'M', enabled: true }],
  });

  it('swapping the current model between same-label entries rebuilds the menu with the new refs', () => {
    let main = 'A/m';
    let recent = ['A/m', 'B/m'];
    let notify: (() => void) | null = null;
    const select = jest.fn();
    const m = new TrayManager({
      providers: providers as never,
      models: {
        state: () => ({
          providers: [provider('A'), provider('B')],
          clients: { nomi: { models: { main } } },
          recentNomi: recent,
        }),
        select,
        onChange: (fn: () => void) => {
          notify = fn;
          return () => undefined;
        },
      } as never,
      i18n,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      openChat: jest.fn(),
      openProviderPanel: jest.fn(),
      quit: jest.fn(),
    });
    m.start();
    const tray = trayInstances[0]!;
    const radios = () =>
      (
        tray.setContextMenu.mock.calls.at(-1)![0] as Array<{
          type?: string;
          checked?: boolean;
          click?: () => void;
        }>
      ).filter((i) => i.type === 'radio');
    expect(radios().map((r) => r.checked)).toEqual([true, false]);

    // 在设置里把当前模型改成 B/m：文字与勾选和之前一模一样，但两行对应的模型换了
    main = 'B/m';
    recent = ['B/m', 'A/m'];
    notify!();
    expect(radios().map((r) => r.checked)).toEqual([true, false]);
    radios()[1]!.click!();
    expect(select).toHaveBeenLastCalledWith('A/m');

    // 真的什么都没变：不重建（防闪烁的优化仍然有效）
    const calls = tray.setContextMenu.mock.calls.length;
    notify!();
    expect(tray.setContextMenu.mock.calls.length).toBe(calls);
    m.dispose();
  });
});
