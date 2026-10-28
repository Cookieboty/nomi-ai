import type { IPCBridge, IpcEventListener, IpcUnsubscribe } from '@nomi-ai/ai-sdk-client';
import type { IpcInvokeEventLike, IpcMainLike } from '@nomi-ai/contract';

/**
 * 内存版 ipcMain + 渲染窗口：契约的 IPC 传输（`createIpcServerTransport`）挂在 `main` 上，
 * 每个窗口拿到一个与 preload 暴露的 `window.nomiTransport` 同形的 `bridge`。
 * 主进程发给窗口的帧按微任务异步投递（与真实 IPC 一样不会同步重入），并记录在 `sent` 里。
 */

export interface FakeRendererWindow {
  id: number;
  bridge: IPCBridge;
  /** 主进程 → 该窗口的全部消息 */
  sent: Array<{ channel: string; payload: unknown }>;
  destroyed: boolean;
  destroy(): void;
}

export interface FakeContractIpc {
  main: IpcMainLike;
  addWindow(id: number, onDestroy?: (id: number) => void): FakeRendererWindow;
}

export function createFakeContractIpc(): FakeContractIpc {
  const handlers = new Map<string, (event: IpcInvokeEventLike, ...args: unknown[]) => unknown>();
  const main: IpcMainLike = {
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error(`handle already registered: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };

  return {
    main,
    addWindow(id, onDestroy) {
      const listeners = new Map<string, Set<IpcEventListener>>();
      const win: FakeRendererWindow = {
        id,
        sent: [],
        destroyed: false,
        destroy() {
          if (win.destroyed) return;
          win.destroyed = true;
          listeners.clear();
          onDestroy?.(id);
        },
        bridge: {
          async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
            if (win.destroyed) throw new Error('[e2e-ipc] window destroyed');
            const handler = handlers.get(channel);
            if (!handler) throw new Error(`no handler for ${channel}`);
            const event: IpcInvokeEventLike = {
              senderId: id,
              senderUrl: `e2e://window/${id}`,
              isDestroyed: () => win.destroyed,
              send(ch, payload) {
                win.sent.push({ channel: ch, payload });
                queueMicrotask(() => {
                  for (const fn of [...(listeners.get(ch) ?? [])]) fn(payload);
                });
              },
            };
            return (await handler(event, ...args)) as T;
          },
          on<T = unknown>(channel: string, fn: IpcEventListener<T>): IpcUnsubscribe {
            let bucket = listeners.get(channel);
            if (!bucket) {
              bucket = new Set();
              listeners.set(channel, bucket);
            }
            bucket.add(fn as IpcEventListener);
            return () => bucket?.delete(fn as IpcEventListener);
          },
        },
      };
      return win;
    },
  };
}
