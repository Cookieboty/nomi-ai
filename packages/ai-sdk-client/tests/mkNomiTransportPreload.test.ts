import { IPC_FRAME_CHANNEL, IPC_REQUEST_CHANNEL } from '@nomi-ai/contract';
import { NOMI_TRANSPORT_GLOBAL } from '@nomi-ai/contract/app';
import { describe, expect, it, vi } from 'vitest';

import {
  mkNomiTransportPreload,
  NOMI_TRANSPORT_BRIDGE_NAME,
  NOMI_TRANSPORT_FRAME_CHANNEL,
  NOMI_TRANSPORT_REQUEST_CHANNEL,
} from '../src/preload/mkNomiTransportPreload';

function makeMocks() {
  const contextBridge = { exposeInMainWorld: vi.fn() };
  const listeners: Array<{ channel: string; fn: (event: unknown, ...a: unknown[]) => void }> = [];
  const ipcRenderer = {
    invoke: vi.fn(async (_channel: string, ...args: unknown[]) => args),
    on: vi.fn((channel: string, fn: (event: unknown, ...a: unknown[]) => void) => {
      listeners.push({ channel, fn });
    }),
    removeListener: vi.fn((channel: string, fn: (event: unknown, ...a: unknown[]) => void) => {
      const i = listeners.findIndex((l) => l.channel === channel && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    }),
  };
  return { contextBridge, ipcRenderer, listeners };
}

describe('mkNomiTransportPreload', () => {
  it('写死的通道名 / 全局名与契约常量一致（preload 不 import 契约，免得把 zod 打进去）', () => {
    expect(NOMI_TRANSPORT_REQUEST_CHANNEL).toBe(IPC_REQUEST_CHANNEL);
    expect(NOMI_TRANSPORT_FRAME_CHANNEL).toBe(IPC_FRAME_CHANNEL);
    expect(NOMI_TRANSPORT_BRIDGE_NAME).toBe(NOMI_TRANSPORT_GLOBAL);
  });

  it('挂到 window.nomiTransport', () => {
    const { contextBridge, ipcRenderer } = makeMocks();
    const api = mkNomiTransportPreload({ contextBridge, ipcRenderer });
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('nomiTransport', api);
  });

  it('invoke 只放行 contract:request，且只转发一个载荷', async () => {
    const { contextBridge, ipcRenderer } = makeMocks();
    const api = mkNomiTransportPreload({ contextBridge, ipcRenderer });
    const invoke = api.invoke as (channel: string, ...a: unknown[]) => Promise<unknown>;
    await expect(invoke('contract:request', { c: '1' }, 'smuggled')).resolves.toEqual([{ c: '1' }]);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('contract:request', { c: '1' });
    expect(() => invoke('ai:chat:stream', {})).toThrowError(/not allowed/);
    expect(() => invoke('contract:frame', {})).toThrowError(/not allowed/);
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
  });

  it('on 只放行 contract:frame，剥掉 IpcRendererEvent，退订移除监听', () => {
    const { contextBridge, ipcRenderer, listeners } = makeMocks();
    const api = mkNomiTransportPreload({ contextBridge, ipcRenderer });
    expect(() => api.on('ai:event', () => undefined)).toThrowError(/not allowed/);
    const seen: unknown[] = [];
    const off = api.on('contract:frame', (p) => seen.push(p));
    listeners[0]!.fn({ sender: 'x' }, { c: '1', frame: { t: 'event' } });
    expect(seen).toEqual([{ c: '1', frame: { t: 'event' } }]);
    off();
    expect(listeners).toHaveLength(0);
  });
});
