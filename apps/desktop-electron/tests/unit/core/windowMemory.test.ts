jest.mock('electron', () => ({
  BrowserWindow: class {},
  screen: {
    getPrimaryDisplay: () => ({
      id: 1,
      workAreaSize: { width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getAllDisplays: () => [],
  },
  app: { isPackaged: true, getPath: () => '/tmp' },
}));

import { WindowManager } from '../../../src/core/WindowManager';

type Internals = {
  createWindow: (o: unknown, type: string) => Promise<unknown>;
  setupMainWindowEvents: (w: unknown) => void;
  loadMainWindowContent: (w: unknown) => Promise<void>;
  setupAiChatWindowEvents: (w: unknown) => void;
};

const logger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

const config = () => {
  const store: Record<string, unknown> = { windowPosition: { x: 5, y: 6 }, mascotScale: 1 };
  return {
    getConfig: () => store,
    set: jest.fn((k: string, v: unknown) => (store[k] = v)),
    save: jest.fn(async () => undefined),
  };
};

const mascotWin = () => {
  let destroyed = false;
  let visible = false;
  return {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    destroy: jest.fn(() => (destroyed = true)),
    showInactive: jest.fn(() => (visible = true)),
    show: jest.fn(() => (visible = true)),
    focus: jest.fn(),
    getPosition: () => [120, 340],
    webContents: { id: 7, setAudioMuted: jest.fn() },
    isResizable: () => false,
    setResizable: jest.fn(),
    setBounds: jest.fn(),
    getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  };
};

function mascotSetup(hidden: { v: boolean }) {
  const cfg = config();
  const wm = new WindowManager(logger() as never, cfg as never);
  wm.mascotHidden = () => hidden.v;
  const wins: ReturnType<typeof mascotWin>[] = [];
  const internals = wm as unknown as Internals;
  internals.createWindow = jest.fn(async () => {
    const w = mascotWin();
    wins.push(w);
    return w;
  });
  internals.setupMainWindowEvents = jest.fn();
  internals.loadMainWindowContent = jest.fn(async () => undefined);
  return { wm, cfg, wins, internals };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('桌面角色关闭时释放窗口（Rive 随渲染进程一起释放）', () => {
  it('关闭 → 位置落盘并销毁窗口；重新显示 → 按配置重建，多次往返都能重建', async () => {
    const hidden = { v: false };
    const { wm, cfg, wins } = mascotSetup(hidden);
    await wm.createMainWindow({ activate: false });
    for (let i = 0; i < 3; i++) {
      const w = wm.getMainWindow() as unknown as ReturnType<typeof mascotWin>;
      hidden.v = true;
      wm.setMascotVisible(false);
      expect(w.destroy).toHaveBeenCalledTimes(1);
      expect(wm.getMainWindow()).toBeNull();
      expect(cfg.set).toHaveBeenCalledWith('windowPosition.x', 120);
      expect(cfg.set).toHaveBeenCalledWith('windowPosition.y', 340);
      hidden.v = false;
      wm.setMascotVisible(true);
      await flush();
      expect(wm.getMainWindow()).toBe(wins[i + 1]);
    }
    expect(wins).toHaveLength(4);
  });

  it('创建期间被关闭：加载完直接释放，不留隐藏的渲染进程', async () => {
    const hidden = { v: false };
    const { wm, wins, internals } = mascotSetup(hidden);
    let done!: () => void;
    internals.loadMainWindowContent = jest.fn(() => new Promise<void>((r) => (done = r)));
    const p = wm.createMainWindow({ activate: false });
    await flush();
    hidden.v = true;
    done();
    await p;
    expect(wins[0]!.destroy).toHaveBeenCalled();
    expect(wm.getMainWindow()).toBeNull();
  });

  it('并发 createMainWindow 只建一个窗口', async () => {
    const { wm, internals } = mascotSetup({ v: false });
    const [a, b] = await Promise.all([wm.createMainWindow(), wm.createMainWindow()]);
    expect(a).toBe(b);
    expect(internals.createWindow).toHaveBeenCalledTimes(1);
  });

  it('确认框临时召回：关闭状态下建窗口，答完 releaseMascot 再释放', async () => {
    const hidden = { v: true };
    const { wm, wins } = mascotSetup(hidden);
    wm.summonMascot();
    await flush();
    const w = wins[0]!;
    expect(wm.getMainWindow()).toBe(w);
    expect(w.destroy).not.toHaveBeenCalled();
    wm.releaseMascot();
    expect(w.destroy).toHaveBeenCalled();
    expect(wm.getMainWindow()).toBeNull();
  });

  it('桌面角色显示时 releaseMascot 不动窗口', async () => {
    const { wm, wins } = mascotSetup({ v: false });
    await wm.createMainWindow();
    wm.releaseMascot();
    expect(wins[0]!.destroy).not.toHaveBeenCalled();
  });
});

describe('对话窗口隐藏后空闲回收', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const chat = () => {
    const handlers: Record<string, (() => void)[]> = {};
    let visible = true;
    let destroyed = false;
    const win = {
      on: (ev: string, fn: () => void) => (handlers[ev] ??= []).push(fn),
      emit: (ev: string) => handlers[ev]?.forEach((f) => f()),
      webContents: { id: 42, on: jest.fn() },
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      isMinimized: () => false,
      isFullScreen: () => false,
      isMaximized: () => false,
      getNormalBounds: () => ({ x: 1, y: 2, width: 900, height: 700 }),
      hide() {
        visible = false;
        win.emit('hide');
      },
      show() {
        visible = true;
        win.emit('show');
      },
      destroy: jest.fn(() => {
        destroyed = true;
        win.emit('closed');
      }),
    };
    return win;
  };

  const setup = (busy: () => boolean) => {
    const cfg = config();
    const wm = new WindowManager(logger() as never, cfg as never);
    wm.chatIdleDestroyMs = 1000;
    wm.webContentsBusy = jest.fn(busy);
    const quit = jest.fn();
    wm.shouldQuitOnChatClose = () => true;
    wm.requestQuit = quit;
    const win = chat();
    (wm as unknown as Internals).setupAiChatWindowEvents(win);
    return { wm, win, quit, cfg };
  };

  it('隐藏且空闲 → 销毁，不当作关闭主界面（不退出）', () => {
    const { wm, win, quit, cfg } = setup(() => false);
    win.hide();
    jest.advanceTimersByTime(999);
    expect(win.destroy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(win.destroy).toHaveBeenCalled();
    expect(wm.webContentsBusy).toHaveBeenCalledWith(42);
    expect(cfg.set).toHaveBeenCalledWith('chatWindowBounds', expect.objectContaining({ x: 1 }));
    expect(quit).not.toHaveBeenCalled();
  });

  it('有进行中的请求 / 流 → 不销毁，空闲后再回收', () => {
    let busy = true;
    const { win } = setup(() => busy);
    win.hide();
    jest.advanceTimersByTime(3000);
    expect(win.destroy).not.toHaveBeenCalled();
    busy = false;
    jest.advanceTimersByTime(1000);
    expect(win.destroy).toHaveBeenCalled();
  });

  it('隐藏后又显示 → 取消回收', () => {
    const { win } = setup(() => false);
    win.hide();
    jest.advanceTimersByTime(500);
    win.show();
    jest.advanceTimersByTime(5000);
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it('回收后用户真关闭新窗口仍按「关闭即退出」处理', () => {
    const a = setup(() => false);
    a.win.hide();
    jest.advanceTimersByTime(1000);
    expect(a.quit).not.toHaveBeenCalled();
    const b = chat();
    (a.wm as unknown as Internals).setupAiChatWindowEvents(b);
    b.emit('closed');
    expect(a.quit).toHaveBeenCalledTimes(1);
  });
});
