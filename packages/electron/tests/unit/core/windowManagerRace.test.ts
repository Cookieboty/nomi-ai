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
  const closedHandler = (shouldQuit: boolean) => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const wm = new WindowManager(logger as never, {} as never);
    wm.shouldQuitOnChatClose = () => shouldQuit;
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

  it('quit → emits app:quit; hide → keeps running', () => {
    const { eventBus } = jest.requireActual('../../../src/core/EventBus') as {
      eventBus: { on: (e: string, fn: () => void) => void; off?: unknown };
    };
    const quit = jest.fn();
    eventBus.on('app:quit', quit);
    closedHandler(false)();
    expect(quit).not.toHaveBeenCalled();
    closedHandler(true)();
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
