/**
 * createElectronIpcAdapter（host/electronIpcAdapter.ts，原在 ai-runtime）：on/off 包装引用配对，
 * 同一 (channel, listener) 重复注册不得在 ipcMain 上残留旧监听器；事件包装出 sender 信息。
 */
type Listener = (...args: unknown[]) => void;
const mockChannels = new Map<string, Set<Listener>>();
const mockIpcMain = {
  handle: jest.fn(),
  removeHandler: jest.fn((ch: string) => mockChannels.delete(ch)),
  on: (ch: string, fn: Listener) => {
    if (!mockChannels.has(ch)) mockChannels.set(ch, new Set());
    mockChannels.get(ch)!.add(fn);
  },
  off: (ch: string, fn: Listener) => mockChannels.get(ch)?.delete(fn),
  emit: (ch: string, ...args: unknown[]) => mockChannels.get(ch)?.forEach((fn) => fn(...args)),
  listenerCount: (ch: string) => mockChannels.get(ch)?.size ?? 0,
};

jest.mock('electron', () => ({
  ipcMain: mockIpcMain,
  webContents: { getAllWebContents: () => [] },
}));

import type { IpcInvokeEvent } from '@nomi-ai/ai-runtime';

import { createElectronIpcAdapter } from '../../../src/host/electronIpcAdapter';

const fakeEvent = { sender: { id: 1, isDestroyed: () => false } } as never;

describe('createElectronIpcAdapter on/off', () => {
  beforeEach(() => mockChannels.clear());

  it('off 能真正注销 on 注册的包装监听器', () => {
    const adapter = createElectronIpcAdapter();
    const listener = jest.fn();
    adapter.on('ai:event', listener);

    mockIpcMain.emit('ai:event', fakeEvent, 'a');
    expect(listener).toHaveBeenCalledTimes(1);

    adapter.off('ai:event', listener);
    mockIpcMain.emit('ai:event', fakeEvent, 'b');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('同一 (channel, listener) 重复 on 不残留旧监听器，emit 只触发一次', () => {
    const adapter = createElectronIpcAdapter();
    const listener = jest.fn();
    adapter.on('ai:event', listener);
    adapter.on('ai:event', listener);

    expect(mockIpcMain.listenerCount('ai:event')).toBe(1);
    mockIpcMain.emit('ai:event', fakeEvent, 'a');
    expect(listener).toHaveBeenCalledTimes(1);

    // 一次 off 即可全部注销
    adapter.off('ai:event', listener);
    expect(mockIpcMain.listenerCount('ai:event')).toBe(0);
  });

  it('handle 把 sender / frame 包装成 IpcInvokeEvent；senderFrame 抛错时没有 frame url', async () => {
    const adapter = createElectronIpcAdapter();
    let seen: IpcInvokeEvent | undefined;
    adapter.handle('contract:request', (event, arg) => {
      seen = event;
      return arg;
    });
    const registered = mockIpcMain.handle.mock.calls.at(-1)?.[1] as (
      e: unknown,
      ...a: unknown[]
    ) => Promise<unknown>;
    const send = jest.fn();
    const event = {
      sender: { id: 9, getURL: () => 'file:///app/index.html', isDestroyed: () => false, send },
      get senderFrame(): never {
        throw new Error('frame gone');
      },
    };
    await expect(registered(event, 'x')).resolves.toBe('x');
    expect(seen?.senderId).toBe(9);
    expect(seen?.senderUrl).toBe('file:///app/index.html');
    expect(seen?.senderFrameUrl).toBeUndefined();
    seen?.send('ch', 1);
    expect(send).toHaveBeenCalledWith('ch', 1);
    expect(seen?.isDestroyed?.()).toBe(false);
  });
});
