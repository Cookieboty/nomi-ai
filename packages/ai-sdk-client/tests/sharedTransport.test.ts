/**
 * 窗口共享的契约传输（P1b）：ClientAIClient 与视图的 createAppClient 共用一个会话；
 * 某个客户端 dispose / $close 不断开别人；没装上传输时调用失败，装上之后已经建好的客户端也可用。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClientAIClient } from '../src/ClientAIClient';
import { SDKErrorCodes } from '../src/errors';
import {
  createAppClient,
  getSharedTransport,
  installSharedTransport,
  resetSharedTransportForTest,
} from '../src/sharedTransport';

import { createFakeServer } from './fakeServer';

const session = { id: 's1', title: 't', createdAt: 1, updatedAt: 1 };

function install() {
  const server = createFakeServer({ 'ai.sessions.list': () => [session] });
  installSharedTransport(server.connect({ surface: 'chat', trusted: true }));
  return server;
}

afterEach(() => {
  resetSharedTransportForTest();
});

describe('getSharedTransport / createAppClient', () => {
  it('同一窗口的 ClientAIClient 与 createAppClient 共用一个会话', async () => {
    const server = install();
    const ai = new ClientAIClient();
    const api = createAppClient();
    await expect((ai.sessions as { list: () => Promise<unknown> }).list()).resolves.toEqual([
      session,
    ]);
    await expect(api.ai.sessions.list()).resolves.toEqual([session]);
    expect(server.sessionCount).toBe(1);
    expect(getSharedTransport()).toBe(getSharedTransport());
  });

  it('某个客户端 dispose / $close 不断开共享传输', async () => {
    install();
    const ai = new ClientAIClient();
    const api = createAppClient();
    await ai.dispose();
    api.$close();
    await expect(createAppClient().ai.sessions.list()).resolves.toEqual([session]);
  });

  it('没装上传输：调用以 BRIDGE_MISSING 失败、订阅不生效', async () => {
    const client = new ClientAIClient();
    expect(() => client.on('agent:step', () => undefined)).not.toThrow();
    await expect(createAppClient().ai.sessions.list()).rejects.toMatchObject({
      code: SDKErrorCodes.BRIDGE_MISSING,
    });
    const stream = (client.chat as { stream: (o: unknown) => AsyncIterable<unknown> }).stream({
      messages: [],
    });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: SDKErrorCodes.BRIDGE_MISSING,
    });
  });
});

describe('installSharedTransport', () => {
  it('换上传输后，之前已经建好的客户端也走它', async () => {
    // 在换传输之前就建好（视图的 api 与 AIProvider 的 ClientAIClient 都在模块加载时建）
    const api = createAppClient();
    const ai = new ClientAIClient();
    const server = install();
    await expect(api.ai.sessions.list()).resolves.toEqual([session]);
    await expect((ai.sessions as { list: () => Promise<unknown> }).list()).resolves.toEqual([
      session,
    ]);
    expect(server.sessionCount).toBe(1);
  });

  it('包的另一份副本（react 入口单独打包）拿到的是同一个共享传输', async () => {
    install();
    vi.resetModules();
    const copy = await import('../src/sharedTransport?copy');
    expect(copy.getSharedTransport).not.toBe(getSharedTransport); // 确实是另一份模块
    expect(copy.getSharedTransport()).toBe(getSharedTransport());
    await expect(copy.createAppClient().ai.sessions.list()).resolves.toEqual([session]);
  });
});
