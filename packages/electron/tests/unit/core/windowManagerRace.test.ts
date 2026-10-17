jest.mock('electron', () => ({
  BrowserWindow: class {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  app: { isPackaged: true, getPath: () => '/tmp' },
}));

import { WindowManager } from '../../../src/core/WindowManager';

type Internals = {
  createWindow: (o: unknown, type: string) => Promise<unknown>;
  setupAiChatWindowEvents: (w: unknown) => void;
  loadAiChatWindowContent: (w: unknown) => Promise<void>;
};

function make() {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const wm = new WindowManager(logger as never, {} as never);
  const win = { focus: jest.fn(), show: jest.fn() };
  const internals = wm as unknown as Internals;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const createWindow = jest.fn(async () => {
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
    const win = { focus: jest.fn(), show: jest.fn() };
    internals.createWindow = jest.fn(async () => {
      if (++n === 1) throw new Error('boom');
      return win;
    });
    release();
    await expect(wm.createAiChatWindow()).rejects.toThrow('boom');
    await expect(wm.createAiChatWindow()).resolves.toBe(win);
  });
});
