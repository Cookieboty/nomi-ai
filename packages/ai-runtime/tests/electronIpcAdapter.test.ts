/**
 * createElectronIpcAdapter —— on/off 包装引用配对，以及同一 (channel, listener)
 * 重复注册不得在 ipcMain 上残留旧监听器。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock 工厂会被提升到 import 之前执行，mock 所需对象必须在 hoisted 内自建。
// 源码通过 nodeRequire()('electron') 取 ipcMain，故直接 mock nodeRequire。
const { ipcMain } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const channels = new Map<string, Set<Listener>>();
  const ipcMain = {
    handle: vi.fn(),
    removeHandler: vi.fn((ch: string) => channels.delete(ch)),
    on: (ch: string, fn: Listener) => {
      if (!channels.has(ch)) channels.set(ch, new Set());
      channels.get(ch)!.add(fn);
    },
    off: (ch: string, fn: Listener) => channels.get(ch)?.delete(fn),
    emit: (ch: string, ...args: unknown[]) => channels.get(ch)?.forEach((fn) => fn(...args)),
    listenerCount: (ch: string) => channels.get(ch)?.size ?? 0,
    removeAllListeners: (ch?: string) => (ch ? channels.delete(ch) : channels.clear()),
  };
  return { ipcMain };
});

vi.mock('../src/nodeRequire', () => ({
  nodeRequire: () => () => ({
    ipcMain,
    webContents: { getAllWebContents: () => [] },
  }),
}));

import { createElectronIpcAdapter } from '../src/IpcAdapter';

const fakeEvent = { sender: { id: 1, isDestroyed: () => false } } as never;

describe('createElectronIpcAdapter on/off', () => {
  beforeEach(() => ipcMain.removeAllListeners());

  it('off 能真正注销 on 注册的包装监听器', () => {
    const adapter = createElectronIpcAdapter();
    const listener = vi.fn();
    adapter.on('ai:event', listener);

    ipcMain.emit('ai:event', fakeEvent, 'a');
    expect(listener).toHaveBeenCalledTimes(1);

    adapter.off('ai:event', listener);
    ipcMain.emit('ai:event', fakeEvent, 'b');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('同一 (channel, listener) 重复 on 不残留旧监听器，emit 只触发一次', () => {
    const adapter = createElectronIpcAdapter();
    const listener = vi.fn();
    adapter.on('ai:event', listener);
    adapter.on('ai:event', listener);

    expect(ipcMain.listenerCount('ai:event')).toBe(1);
    ipcMain.emit('ai:event', fakeEvent, 'a');
    expect(listener).toHaveBeenCalledTimes(1);

    // 一次 off 即可全部注销
    adapter.off('ai:event', listener);
    expect(ipcMain.listenerCount('ai:event')).toBe(0);
  });
});
