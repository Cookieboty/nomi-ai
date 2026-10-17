/**
 * FakeIpcAdapter —— 纯内存模拟 Electron `ipcMain` + `webContents`。
 *
 * 与真实 Electron 的语义保持一致：
 * - `handle(ch, fn)` 只能注册一次，重复注册抛错；
 * - `on/off(ch, fn)` 多监听器；
 * - `invoke(ch, ...args)` 返回 Promise，抛出的错误会 reject；
 * - `sendFrom(senderId, ch, ...args)` 触发 `on(ch)` 监听器；
 * - `getAllWebContents()` 返回受控的假 WebContents 集合。
 */

import type { IpcAdapter, IpcHandler, IpcInvokeEvent, WebContentsLike } from '../../src/IpcAdapter';

export interface FakeWebContents extends WebContentsLike {
  sent: Array<{ channel: string; payload: unknown }>;
  destroy(): void;
}

export interface FakeIpcAdapter extends IpcAdapter {
  invoke(senderId: number, channel: string, ...args: unknown[]): Promise<unknown>;
  emitTo(senderId: number, channel: string, ...args: unknown[]): void;
  addWebContents(id?: number): FakeWebContents;
  webContents: FakeWebContents[];
  handlers: Map<string, IpcHandler>;
  senderStreams: Map<number, Array<{ channel: string; payload: unknown }>>;
  /** 模拟发送方窗口被销毁：之后对它 send 会抛错（同 Electron "Object has been destroyed"） */
  destroySender(senderId: number): void;
}

export function createFakeIpcAdapter(): FakeIpcAdapter {
  const handlers = new Map<string, IpcHandler>();
  const listeners = new Map<string, Set<(event: IpcInvokeEvent, ...args: unknown[]) => void>>();
  const webContents: FakeWebContents[] = [];
  const senderStreams = new Map<number, Array<{ channel: string; payload: unknown }>>();
  const destroyed = new Set<number>();
  let nextId = 100;

  const makeEvent = (senderId: number): IpcInvokeEvent => ({
    senderId,
    senderUrl: `test://sender/${senderId}`,
    isDestroyed: () => destroyed.has(senderId),
    send(channel, payload) {
      if (destroyed.has(senderId)) throw new Error('Object has been destroyed');
      let bucket = senderStreams.get(senderId);
      if (!bucket) {
        bucket = [];
        senderStreams.set(senderId, bucket);
      }
      bucket.push({ channel, payload });
    },
  });

  const adapter: FakeIpcAdapter = {
    handlers,
    webContents,
    senderStreams,
    destroySender(id) {
      destroyed.add(id);
    },
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error(`handle already registered: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    on(channel, listener) {
      let bucket = listeners.get(channel);
      if (!bucket) {
        bucket = new Set();
        listeners.set(channel, bucket);
      }
      bucket.add(listener);
    },
    off(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
    getAllWebContents() {
      return webContents;
    },
    async invoke(senderId, channel, ...args) {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler for ${channel}`);
      return h(makeEvent(senderId), ...args);
    },
    emitTo(senderId, channel, ...args) {
      const bucket = listeners.get(channel);
      if (!bucket) return;
      for (const fn of bucket) fn(makeEvent(senderId), ...args);
    },
    addWebContents(id) {
      const wcId = id ?? nextId++;
      let destroyed = false;
      const wc: FakeWebContents = {
        id: wcId,
        sent: [],
        isDestroyed: () => destroyed,
        send(channel, payload) {
          this.sent.push({ channel, payload });
        },
        destroy() {
          destroyed = true;
        },
      };
      webContents.push(wc);
      return wc;
    },
  };
  return adapter;
}
