/**
 * ai-runtime 的 `IpcAdapter` 的 Electron 实现：把 `ipcMain` / `webContents` 适配成契约传输用的
 * 最小接口（host/contractIpc.ts 经 `createIpcServerTransport` 使用）。
 *
 * 原在 ai-runtime（经 `nodeRequire()('electron')` 惰性加载），P3 移入宿主（docs/design/core-host-decoupling.md §6.3）。
 */
import type { IpcAdapter, IpcInvokeEvent } from '@nomi-ai/ai-runtime';
import { ipcMain, webContents, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

type SenderEvent = Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender' | 'senderFrame'>;

/** senderFrame 在 frame 已导航 / 销毁时可能为 null 或访问即抛错 */
function frameUrlOf(e: SenderEvent): string | undefined {
  try {
    return e.senderFrame?.url || undefined;
  } catch {
    return undefined;
  }
}

function wrap(e: SenderEvent): IpcInvokeEvent {
  return {
    senderId: e.sender.id,
    senderUrl: e.sender.getURL?.(),
    senderFrameUrl: frameUrlOf(e),
    send: (ch, payload) => e.sender.send(ch, payload),
    isDestroyed: () => e.sender.isDestroyed?.() ?? false,
  };
}

/** 生产环境使用：把 Electron 的 `ipcMain` / `webContents` 适配成 `IpcAdapter`。 */
export function createElectronIpcAdapter(): IpcAdapter {
  // on 注册到 ipcMain 的是包装函数，off 必须用同一个引用才能注销；
  // 按 (listener, channel) 记录包装函数，否则监听器会泄漏
  const wrappedListeners = new WeakMap<
    (event: IpcInvokeEvent, ...args: unknown[]) => void,
    Map<string, (event: IpcMainEvent, ...args: unknown[]) => void>
  >();

  return {
    handle(channel, handler) {
      ipcMain.handle(channel, async (e, ...args) => handler(wrap(e), ...args));
    },
    removeHandler(channel) {
      ipcMain.removeHandler(channel);
    },
    on(channel, listener) {
      let byChannel = wrappedListeners.get(listener);
      if (!byChannel) {
        byChannel = new Map();
        wrappedListeners.set(listener, byChannel);
      }
      // 同一 (channel, listener) 重复注册：先摘掉旧包装函数，
      // 否则 Map 覆盖后旧监听器仍挂在 ipcMain 上，无法再注销
      const prev = byChannel.get(channel);
      if (prev) ipcMain.off(channel, prev);
      const wrapped = (e: IpcMainEvent, ...args: unknown[]) => listener(wrap(e), ...args);
      byChannel.set(channel, wrapped);
      ipcMain.on(channel, wrapped);
    },
    off(channel, listener) {
      const wrapped = wrappedListeners.get(listener)?.get(channel);
      if (wrapped) {
        ipcMain.off(channel, wrapped);
        wrappedListeners.get(listener)?.delete(channel);
      }
    },
    getAllWebContents() {
      return webContents.getAllWebContents();
    },
  };
}
