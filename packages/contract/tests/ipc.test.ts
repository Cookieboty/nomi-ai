/**
 * IPC 形状的适配：用一对假的 ipcMain / preload 桥模拟 Electron（不 import electron）。
 * 载荷经过 structuredClone，和 Electron IPC 的序列化能力一致。
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  isContractError,
  createClient,
  createIpcClientTransport,
  createIpcServerTransport,
  DEFAULT_MAX_SESSIONS_PER_SENDER,
  defineContract,
  implement,
  IPC_FRAME_CHANNEL,
  IPC_REQUEST_CHANNEL,
  type CallerContext,
  type IpcBridgeLike,
  type IpcInvokeEventLike,
  type IpcMainLike,
} from '../src';

import { makeRouter, sleep, testContract } from './fixtures';

type Handler = (event: IpcInvokeEventLike, ...args: unknown[]) => unknown;

class FakeIpc {
  readonly handlers = new Map<string, Handler>();
  private nextId = 1;

  readonly main: IpcMainLike = {
    handle: (channel, handler) => {
      if (this.handlers.has(channel)) throw new Error(`duplicate handler ${channel}`);
      this.handlers.set(channel, handler);
    },
    removeHandler: (channel) => {
      this.handlers.delete(channel);
    },
  };

  /** 新开一个「窗口」，返回它的 preload 桥 */
  window(url = 'app://chat/index.html') {
    const id = this.nextId++;
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const win = { id, url, destroyed: false };
    const event: IpcInvokeEventLike = {
      senderId: id,
      get senderUrl() {
        return win.url;
      },
      send: (channel, payload) => {
        if (win.destroyed) throw new Error('Object has been destroyed');
        const copy = structuredClone(payload);
        queueMicrotask(() => listeners.get(channel)?.forEach((fn) => fn(copy)));
      },
      isDestroyed: () => win.destroyed,
    };
    const bridge: IpcBridgeLike = {
      invoke: async (channel, ...args) => {
        const h = this.handlers.get(channel);
        if (!h) throw new Error(`No handler registered for '${channel}'`);
        await Promise.resolve();
        return h(event, ...structuredClone(args));
      },
      on: (channel, fn) => {
        let set = listeners.get(channel);
        if (!set) listeners.set(channel, (set = new Set()));
        set.add(fn);
        return () => set.delete(fn);
      },
    };
    return { win, bridge };
  }
}

const byUrl = (event: IpcInvokeEventLike): CallerContext | null => {
  const url = event.senderUrl ?? '';
  if (url.startsWith('app://chat/')) return { surface: 'chat', trusted: true };
  if (url.startsWith('app://mascot/')) return { surface: 'mascot', trusted: true };
  if (url.startsWith('https://')) return { surface: 'chat', trusted: false };
  return null;
};

const dateContract = defineContract({
  version: { major: 1, minor: 0 },
  procedures: { 'x.now': { kind: 'query', input: z.void(), output: z.unknown() } },
});

function setup() {
  const ipc = new FakeIpc();
  const router = makeRouter();
  const transport = createIpcServerTransport(ipc.main, { resolveCaller: byUrl });
  const stop = transport.serve(router);
  return { ipc, router, transport, stop };
}

describe('IPC transport adapters', () => {
  it('serves calls, streams and events over two channels', async () => {
    const { ipc, router } = setup();
    expect([...ipc.handlers.keys()]).toEqual([IPC_REQUEST_CHANNEL]);
    const { bridge } = ipc.window();
    const api = createClient(testContract, createIpcClientTransport(bridge));

    await expect(api.sessions.list()).resolves.toEqual([{ id: 's1', title: 'Hello' }]);
    const s = api.chat.stream({ prompt: 'x y z' });
    const chunks: string[] = [];
    for await (const c of s) chunks.push(c.content);
    expect(chunks).toEqual(['x', 'y', 'z']);
    await expect(s.result).resolves.toEqual({ tokens: 3 });

    const seen = vi.fn();
    api.on('usage.updated', seen);
    await api.sessions.list();
    router.events.publish('usage.updated', { used: 5, limit: 9 });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith({ used: 5, limit: 9 }));
  });

  it('isolates clients sharing one window by client id', async () => {
    const { ipc, router, transport } = setup();
    const { bridge } = ipc.window();
    const a = createClient(testContract, createIpcClientTransport(bridge));
    const b = createClient(testContract, createIpcClientTransport(bridge));
    const seenA = vi.fn();
    const seenB = vi.fn();
    a.on('persona.changed', seenA);
    await Promise.all([a.sessions.list(), b.sessions.list()]);
    expect(transport.sessionCount).toBe(2);
    router.events.publish('persona.changed', { name: 'p' });
    await vi.waitFor(() => expect(seenA).toHaveBeenCalledTimes(1));
    b.on('persona.changed', seenB);
    await b.sessions.list();
    router.events.publish('persona.changed', { name: 'q' });
    await vi.waitFor(() => expect(seenB).toHaveBeenCalledTimes(1));
    expect(seenA).toHaveBeenCalledTimes(2);
  });

  it('fills the caller from the sender (surfaces / trusted)', async () => {
    const { ipc } = setup();
    const mascot = createClient(
      testContract,
      createIpcClientTransport(ipc.window('app://mascot/').bridge),
    );
    await expect(mascot.settings.reset()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const web = createClient(
      testContract,
      createIpcClientTransport(ipc.window('https://evil.example/').bridge),
    );
    await expect(web.tools.confirm({ id: 'x', allow: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses unknown senders', async () => {
    const { ipc } = setup();
    const api = createClient(
      testContract,
      createIpcClientTransport(ipc.window('file:///tmp/x.html').bridge),
    );
    const err = await api.sessions.list().catch((e: unknown) => e);
    expect(isContractError(err, 'FORBIDDEN')).toBe(true);
  });

  it('starts a fresh session when the page navigates to another surface', async () => {
    const { ipc, transport } = setup();
    const { win, bridge } = ipc.window('app://chat/');
    const api = createClient(testContract, createIpcClientTransport(bridge));
    await api.sessions.list();
    win.url = 'app://mascot/';
    await expect(api.settings.reset()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(transport.sessionCount).toBe(1);
  });

  it('stops streaming and aborts the handler when the window is destroyed', async () => {
    const { ipc, transport } = setup();
    const { win, bridge } = ipc.window();
    const api = createClient(testContract, createIpcClientTransport(bridge));
    const s = api.chat.ticks({ n: 1000 });
    const it = s[Symbol.asyncIterator]();
    await it.next();
    expect(transport.sessionCount).toBe(1);
    win.destroyed = true;
    await vi.waitFor(() => expect(transport.sessionCount).toBe(0));
  });

  it('disconnect(senderId) closes that window’s sessions', async () => {
    const { ipc, transport } = setup();
    const one = ipc.window();
    const two = ipc.window();
    await createClient(testContract, createIpcClientTransport(one.bridge)).sessions.list();
    await createClient(testContract, createIpcClientTransport(two.bridge)).sessions.list();
    expect(transport.sessionCount).toBe(2);
    transport.disconnect(one.win.id);
    expect(transport.sessionCount).toBe(1);
  });

  it('caps sessions per sender and evicts the oldest', async () => {
    const { ipc, router, transport } = setup();
    const one = ipc.window();
    const other = ipc.window();
    await createClient(testContract, createIpcClientTransport(other.bridge)).sessions.list();
    const seen: number[] = [];
    const N = DEFAULT_MAX_SESSIONS_PER_SENDER;
    for (let i = 0; i < N + 2; i++) {
      const api = createClient(testContract, createIpcClientTransport(one.bridge));
      await api.sessions.list();
      api.on('persona.changed', () => seen.push(i));
      await api.sessions.list();
    }
    // N 个属于 one（默认上限），1 个属于 other
    expect(transport.sessionCount).toBe(DEFAULT_MAX_SESSIONS_PER_SENDER + 1);
    router.events.publish('persona.changed', { name: 'x' });
    await vi.waitFor(() => expect(seen).toHaveLength(DEFAULT_MAX_SESSIONS_PER_SENDER));
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 2));
    transport.disconnect(one.win.id);
    expect(transport.sessionCount).toBe(1);
  });

  it('fails in-flight calls of an evicted session instead of leaving them hanging', async () => {
    const ipc = new FakeIpc();
    const transport = createIpcServerTransport(ipc.main, {
      resolveCaller: byUrl,
      maxSessionsPerSender: 1,
    });
    transport.serve(makeRouter());
    const { bridge } = ipc.window();
    const a = createClient(testContract, createIpcClientTransport(bridge));
    const b = createClient(testContract, createIpcClientTransport(bridge));
    await a.sessions.list();
    const slow = a.sessions.slow({ ms: 10_000 });
    await sleep(5);
    await b.sessions.list();
    await expect(slow).rejects.toMatchObject({ code: 'TRANSPORT' });
  });

  it('honours a custom maxSessionsPerSender', async () => {
    const ipc = new FakeIpc();
    const transport = createIpcServerTransport(ipc.main, {
      resolveCaller: byUrl,
      maxSessionsPerSender: 1,
    });
    transport.serve(makeRouter());
    const { bridge } = ipc.window();
    const a = createClient(testContract, createIpcClientTransport(bridge));
    const b = createClient(testContract, createIpcClientTransport(bridge));
    await a.sessions.list();
    await b.sessions.list();
    expect(transport.sessionCount).toBe(1);
    // 被挤掉的客户端再调用时重建会话（并挤掉另一个），不会卡住
    await expect(a.sessions.list()).resolves.toHaveLength(1);
    expect(transport.sessionCount).toBe(1);
  });

  it('rejects non-wire-safe results by default (strictSerialize)', async () => {
    const ipc = new FakeIpc();
    const router = implement(dateContract, { 'x.now': () => new Date(0) });
    createIpcServerTransport(ipc.main, { resolveCaller: byUrl }).serve(router);
    const api = createClient(dateContract, createIpcClientTransport(ipc.window().bridge), {
      handshake: 'off',
      validate: { output: false },
    });
    await expect(api.x.now()).rejects.toMatchObject({ code: 'BAD_OUTPUT' });
  });

  it('stop() removes the handler and calls fail with TRANSPORT', async () => {
    const { ipc, stop } = setup();
    const api = createClient(testContract, createIpcClientTransport(ipc.window().bridge));
    await api.sessions.list();
    stop();
    expect(ipc.handlers.size).toBe(0);
    await expect(api.sessions.list()).rejects.toMatchObject({ code: 'TRANSPORT' });
  });

  it('aborts calls across the wire', async () => {
    const { ipc } = setup();
    const api = createClient(testContract, createIpcClientTransport(ipc.window().bridge));
    const ctrl = new AbortController();
    const p = api.sessions.slow({ ms: 10_000 }, { signal: ctrl.signal });
    await sleep(5);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('ignores frames for other clients and malformed envelopes', async () => {
    const { ipc } = setup();
    const { bridge } = ipc.window();
    const handler = ipc.handlers.get(IPC_REQUEST_CHANNEL);
    expect(handler).toBeDefined();
    const got = vi.fn();
    bridge.on(IPC_FRAME_CHANNEL, got);
    await bridge.invoke(IPC_REQUEST_CHANNEL, 'garbage');
    await bridge.invoke(IPC_REQUEST_CHANNEL, {
      c: 'x',
      frame: { t: 'req', id: '1', kind: 'call', name: 'deep.a.b.c', input: 1 },
    });
    await vi.waitFor(() =>
      expect(got).toHaveBeenCalledWith({ c: 'x', frame: { t: 'res', id: '1', output: 2 } }),
    );
    expect(got).toHaveBeenCalledTimes(1);
  });
});
