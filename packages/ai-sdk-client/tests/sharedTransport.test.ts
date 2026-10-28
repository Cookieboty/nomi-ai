/**
 * 窗口共享的契约传输（P1b）：ClientAIClient 与视图的 createAppClient 共用一个会话（同一客户端 id）；
 * 某个客户端 dispose / $close 不断开别人；桥没就绪时调用失败、下次再读。
 */

import {
  createIpcServerTransport,
  type IpcInvokeEventLike,
  type IpcMainLike,
} from '@nomi-ai/contract';
import { afterEach, describe, expect, it } from 'vitest';

import { ClientAIClient } from '../src/ClientAIClient';
import type { IPCBridge } from '../src/IPCBridge';
import {
  createAppClient,
  getSharedTransport,
  installSharedTransport,
  resetSharedTransportForTest,
} from '../src/sharedTransport';

import { createFakeServer } from './fakeServer';

const session = { id: 's1', title: 't', createdAt: 1, updatedAt: 1 };

/** 模拟 ipcMain + preload，记录每个请求信封里的客户端 id */
function installBridge(): { clientIds: Set<string> } {
  const server = createFakeServer({ 'ai.sessions.list': () => [session] });
  let handler: ((e: IpcInvokeEventLike, ...a: unknown[]) => unknown) | undefined;
  const frameListeners = new Set<(p: unknown) => void>();
  const ipcMain: IpcMainLike = {
    handle: (_ch, h) => {
      handler = h;
    },
    removeHandler: () => {
      handler = undefined;
    },
  };
  createIpcServerTransport(ipcMain, {
    resolveCaller: () => ({ surface: 'chat', trusted: true }),
  }).serve(server.router);
  const clientIds = new Set<string>();
  const bridge: IPCBridge = {
    invoke: async <T>(_channel: string, ...args: unknown[]) => {
      clientIds.add((args[0] as { c: string }).c);
      const event: IpcInvokeEventLike = {
        senderId: 1,
        send: (_ch, payload) => queueMicrotask(() => frameListeners.forEach((f) => f(payload))),
      };
      return handler!(event, ...args) as T;
    },
    on: (_channel, fn) => {
      frameListeners.add(fn as (p: unknown) => void);
      return () => frameListeners.delete(fn as (p: unknown) => void);
    },
  };
  (globalThis as Record<string, unknown>).nomiTransport = bridge;
  return { clientIds };
}

afterEach(() => {
  resetSharedTransportForTest();
  delete (globalThis as Record<string, unknown>).nomiTransport;
});

describe('getSharedTransport / createAppClient', () => {
  it('同一窗口的 ClientAIClient 与 createAppClient 共用一个会话', async () => {
    const { clientIds } = installBridge();
    const ai = new ClientAIClient();
    const api = createAppClient();
    await expect((ai.sessions as { list: () => Promise<unknown> }).list()).resolves.toEqual([
      session,
    ]);
    await expect(api.ai.sessions.list()).resolves.toEqual([session]);
    expect(clientIds.size).toBe(1);
    expect(getSharedTransport()).toBe(getSharedTransport());
  });

  it('某个客户端 dispose / $close 不断开共享传输', async () => {
    installBridge();
    const ai = new ClientAIClient();
    const api = createAppClient();
    await ai.dispose();
    api.$close();
    await expect(createAppClient().ai.sessions.list()).resolves.toEqual([session]);
  });

  it('桥没就绪：调用失败；装上之后同一个共享传输可用', async () => {
    const api = createAppClient();
    await expect(api.ai.sessions.list()).rejects.toThrow(/nomiTransport/);
    installBridge();
    await expect(api.ai.sessions.list()).resolves.toEqual([session]);
  });
});

describe('installSharedTransport', () => {
  it('没有 preload 桥的页面：换上别的传输后，已经建好的客户端也走它', async () => {
    const server = createFakeServer({ 'ai.sessions.list': () => [session] });
    // 在换传输之前就建好（视图的 api 与 AIProvider 的 ClientAIClient 都在模块加载时建）
    const api = createAppClient();
    const ai = new ClientAIClient();
    installSharedTransport(server.connect({ surface: 'chat', trusted: true }));
    await expect(api.ai.sessions.list()).resolves.toEqual([session]);
    await expect((ai.sessions as { list: () => Promise<unknown> }).list()).resolves.toEqual([
      session,
    ]);
    expect(server.sessionCount).toBe(1);
    expect((globalThis as Record<string, unknown>).nomiTransport).toBeUndefined();
  });
});
