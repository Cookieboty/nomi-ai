/**
 * IpcAdapter —— 对 Electron `ipcMain` / `webContents` 的最小抽象（纯类型）。
 *
 * 为什么单独抽出：
 * - 允许在 vitest（Node）里注入 fake adapter，无需真的启动 Electron；
 * - 生产环境由宿主注入 Electron 实现（apps/desktop-electron/src/host/electronIpcAdapter.ts），
 *   本包不认识 Electron（docs/design/core-host-decoupling.md §6.3）。
 */

export interface IpcInvokeEvent {
  /** 发起窗口的 id；不可信但足以做白名单过滤 */
  senderId: number;
  /** 发起窗口（主 frame）的 url：来源白名单据此判定 */
  senderUrl?: string;
  /** 实际发起调用的 frame 的 url（可能是被嵌入的子 frame）；有值时也必须受信 */
  senderFrameUrl?: string;
  /** 直接对发送方 send 事件（chunk 通道用） */
  send(channel: string, payload: unknown): void;
  /** 发送方窗口 / webContents 是否已销毁（长流式调用中途窗口被关闭时用来停止推送） */
  isDestroyed?(): boolean;
}

export type IpcHandler = (event: IpcInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>;

export interface WebContentsLike {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface IpcAdapter {
  handle(channel: string, handler: IpcHandler): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: IpcInvokeEvent, ...args: unknown[]) => void): void;
  off(channel: string, listener: (event: IpcInvokeEvent, ...args: unknown[]) => void): void;
  getAllWebContents(): WebContentsLike[];
}
