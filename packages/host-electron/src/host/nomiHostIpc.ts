/**
 * preload 专用通道（docs/design/core-host-decoupling.md §8）：`window.nomiHost` 里不能做成契约过程的能力。
 *
 * 现在只有 `desktop:drop-file`：看板娘窗口的 preload 从真实拖入的 File 取路径（webUtils）后直接发来，
 * 视图代码碰不到这个通道（`window.nomiTransport` 只放行契约的两个通道，视图也没有 ipcRenderer），
 * 所以路径一定来自用户真实拖入的文件。发送方是不是看板娘窗口由 `dropFile` 判定
 * （宿主端口 `windows.ownsCaller('mascot', …)`），其它窗口发来的直接忽略。
 */

import { NOMI_HOST_DROP_FILE_CHANNEL } from '@nomi-ai/ai-sdk-client/preload';
import { ipcMain } from 'electron';

/** `electron.ipcMain` 的子集（单测注入） */
export interface NomiHostIpcMainLike {
  on(
    channel: string,
    listener: (event: { sender: { id: number } }, ...args: unknown[]) => void,
  ): unknown;
  removeListener(channel: string, listener: (...args: never[]) => void): unknown;
}

export interface ServeNomiHostIpcOptions {
  /** 拖入文件：senderId = 发送方 webContents id（是不是看板娘窗口由实现判定） */
  dropFile(senderId: number, path: string): void;
  ipc?: NomiHostIpcMainLike;
}

export function serveNomiHostIpc(opts: ServeNomiHostIpcOptions): () => void {
  const ipc = opts.ipc ?? (ipcMain as unknown as NomiHostIpcMainLike);
  const onDrop = (event: { sender: { id: number } }, ...args: unknown[]): void => {
    const [p] = args;
    if (args.length !== 1 || typeof p !== 'string' || !p) return;
    opts.dropFile(event.sender.id, p);
  };
  ipc.on(NOMI_HOST_DROP_FILE_CHANNEL, onDrop);
  return () => {
    ipc.removeListener(NOMI_HOST_DROP_FILE_CHANNEL, onDrop);
  };
}
