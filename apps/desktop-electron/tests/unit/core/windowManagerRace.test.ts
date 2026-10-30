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

const newWin = () => ({
  maximize: jest.fn(),
  focus: jest.fn(),
  show: jest.fn(),
  showInactive: jest.fn(),
  restore: jest.fn(),
  isMinimized: jest.fn(() => false),
});

type Internals = {
  createWindow: (o: unknown, type: string) => Promise<unknown>;
  setupAiChatWindowEvents: (w: unknown) => void;
  loadAiChatWindowContent: (w: unknown) => Promise<void>;
};

/** 只实现对话窗口用到的配置读写（上次的位置与大小） */
const configStub = (saved?: unknown) => {
  const store: Record<string, unknown> = { chatWindowBounds: saved };
  return {
    getConfig: () => store,
    set: jest.fn((k: string, v: unknown) => (store[k] = v)),
    save: jest.fn(async () => undefined),
  };
};

function make(saved?: unknown) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const wm = new WindowManager(logger as never, configStub(saved) as never);
  const win = newWin();
  const internals = wm as unknown as Internals;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const createWindow = jest.fn(async (_o: unknown, _type: string) => {
    await gate; // 模拟窗口创建的异步耗时
    return win;
  });
  internals.createWindow = createWindow;
  internals.setupAiChatWindowEvents = jest.fn();
  internals.loadAiChatWindowContent = jest.fn(async () => undefined);
  return { wm, win, createWindow, release };
}

describe('WindowManager.createAiChatWindow 并发', () => {
  it('并发调用只创建一个窗口，且都拿到同一个实例', async () => {
    const { wm, win, createWindow, release } = make();
    const a = wm.createAiChatWindow();
    const b = wm.createAiChatWindow();
    const c = wm.createAiChatWindow();
    release();
    const [wa, wb, wc] = await Promise.all([a, b, c]);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(wa).toBe(win);
    expect(wb).toBe(win);
    expect(wc).toBe(win);
    // 创建完成后再调用 → 复用已有窗口并聚焦，仍不新建
    expect(await wm.createAiChatWindow()).toBe(win);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalled();
  });

  it('对话窗口按 chat 窗口类型建（共用 preload 里拿不到 dropFile 的提交通道）', async () => {
    const { wm, createWindow, release } = make();
    const pending = wm.createAiChatWindow();
    release();
    await pending;
    expect(createWindow.mock.calls[0]![0]).toMatchObject({ windowKind: 'chat' });
    expect(createWindow.mock.calls[0]![1]).toBe('aiChat');
  });

  it('创建失败后可以重试（in-flight 标记被清除）', async () => {
    const { wm, release } = make();
    const internals = wm as unknown as Internals;
    let n = 0;
    const win = newWin();
    internals.createWindow = jest.fn(async () => {
      if (++n === 1) throw new Error('boom');
      return win;
    });
    release();
    await expect(wm.createAiChatWindow()).rejects.toThrow('boom');
    await expect(wm.createAiChatWindow()).resolves.toBe(win);
  });
});

describe('WindowManager.createAiChatWindow 显示方式', () => {
  const ready = async () => {
    const m = make();
    m.release();
    await m.wm.createAiChatWindow();
    return m;
  };

  it('默认聚焦已有窗口；最小化时先还原', async () => {
    const { wm, win } = await ready();
    win.isMinimized.mockReturnValue(true);
    await wm.createAiChatWindow();
    expect(win.restore).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.showInactive).not.toHaveBeenCalled();
  });

  it('activate: false 只显示、不抢焦点（开机自启）', async () => {
    const { wm, win } = await ready();
    win.focus.mockClear();
    win.show.mockClear();
    await wm.createAiChatWindow({ activate: false });
    expect(win.showInactive).toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
  });

  it('activate: false 会传给新建窗口的 showInactive 选项', async () => {
    const m = make();
    m.release();
    await m.wm.createAiChatWindow({ activate: false });
    expect(m.createWindow.mock.calls[0]![0]).toMatchObject({ showInactive: true });
  });
});

describe('WindowManager 对话窗口记住上次的位置与大小', () => {
  it('有保存的位置与大小：按它创建，最大化的再最大化', async () => {
    const m = make({ x: 100, y: 60, width: 1300, height: 900, maximized: true });
    m.release();
    await m.wm.createAiChatWindow();
    expect(m.createWindow.mock.calls[0]![0]).toMatchObject({
      x: 100,
      y: 60,
      width: 1300,
      height: 900,
    });
    expect(m.win.maximize).toHaveBeenCalledTimes(1);
  });

  it('没有保存过：居中默认尺寸，不最大化', async () => {
    const m = make();
    m.release();
    await m.wm.createAiChatWindow();
    expect(m.createWindow.mock.calls[0]![0]).toMatchObject({ width: 1120, height: 820 });
    expect(m.win.maximize).not.toHaveBeenCalled();
  });

  it('关闭时保存还原后的位置与大小（最大化只记标记）', () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const config = configStub();
    const wm = new WindowManager(logger as never, config as never);
    const handlers: Record<string, () => void> = {};
    const win = {
      on: (ev: string, fn: () => void) => (handlers[ev] = fn),
      webContents: { on: jest.fn() },
      isDestroyed: () => false,
      isMinimized: () => false,
      isFullScreen: () => false,
      isMaximized: () => true,
      getNormalBounds: () => ({ x: 10, y: 20, width: 1000, height: 700 }),
    };
    (wm as unknown as { setupAiChatWindowEvents: (w: unknown) => void }).setupAiChatWindowEvents(
      win,
    );
    handlers.close!();
    expect(config.set).toHaveBeenCalledWith('chatWindowBounds', {
      x: 10,
      y: 20,
      width: 1000,
      height: 700,
      maximized: true,
    });
    expect(config.save).toHaveBeenCalled();
  });
});

describe('WindowManager 关闭主界面时', () => {
  const closedHandler = (shouldQuit: boolean, quit: () => void) => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const wm = new WindowManager(logger as never, {} as never);
    wm.shouldQuitOnChatClose = () => shouldQuit;
    wm.requestQuit = quit;
    const handlers: Record<string, () => void> = {};
    const win = {
      on: (ev: string, fn: () => void) => (handlers[ev] = fn),
      webContents: { on: jest.fn() },
    };
    (wm as unknown as { setupAiChatWindowEvents: (w: unknown) => void }).setupAiChatWindowEvents(
      win,
    );
    return handlers.closed!;
  };

  it('quit → requests the unified quit; hide → keeps running', () => {
    const quit = jest.fn();
    closedHandler(false, quit)();
    expect(quit).not.toHaveBeenCalled();
    closedHandler(true, quit)();
    expect(quit).toHaveBeenCalledTimes(1);
  });
});

describe('WindowManager 启动时两个窗口并行', () => {
  it('桌面角色页面还在加载时，对话窗口可以并行创建并加载完成', async () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const config = {
      getConfig: () => ({ windowPosition: { x: 0, y: 0 }, mascotScale: 1 }),
      set: jest.fn(),
      save: jest.fn(async () => undefined),
    };
    const wm = new WindowManager(logger as never, config as never);
    const mascot = {
      ...newWin(),
      webContents: { setAudioMuted: jest.fn() },
      // Windows 下 createMainWindow 会校正窗口尺寸（setWindowBounds）
      isResizable: jest.fn(() => false),
      setResizable: jest.fn(),
      setBounds: jest.fn(),
      getBounds: jest.fn(() => ({ x: 0, y: 0, width: 0, height: 0 })),
    };
    const chat = newWin();
    const internals = wm as unknown as Internals & {
      setupMainWindowEvents: (w: unknown) => void;
      loadMainWindowContent: (w: unknown) => Promise<void>;
    };
    internals.createWindow = jest.fn(async (_o: unknown, type: string) =>
      type === 'main' ? mascot : chat,
    );
    internals.setupMainWindowEvents = jest.fn();
    internals.setupAiChatWindowEvents = jest.fn();
    let releaseMascot!: () => void;
    internals.loadMainWindowContent = jest.fn(() => new Promise<void>((r) => (releaseMascot = r)));
    internals.loadAiChatWindowContent = jest.fn(async () => undefined);

    // 与 Application.start 的顺序一致：先发起对话窗口，再等桌面角色
    const chatP = wm.createAiChatWindow({ activate: true });
    const mascotP = wm.createMainWindow({ activate: false });
    await expect(chatP).resolves.toBe(chat);
    expect(wm.getAiChatWindow()).toBe(chat);
    expect(internals.loadMainWindowContent).toHaveBeenCalledTimes(1);

    releaseMascot();
    await expect(mascotP).resolves.toBe(mascot);
    expect(wm.getMainWindow()).toBe(mascot);
    // 桌面角色以不抢焦点的方式出现，对话窗口照常聚焦
    const calls = (internals.createWindow as jest.Mock).mock.calls;
    expect(calls.find((c) => c[1] === 'main')![0]).toMatchObject({ showInactive: true });
    expect(calls.find((c) => c[1] === 'aiChat')![0]).toMatchObject({ showInactive: false });
  });
});
