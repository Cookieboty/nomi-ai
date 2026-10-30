import { BrowserWindow } from 'electron';

/**
 * 当前存活的窗口数（没销毁、webContents 也没销毁）：内核的引导服务据此判断发给桌面角色的指令是否送达
 * （`createCore` 的 `host.liveWindows`）。
 */
export function countLiveWindows(): number {
  return BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && !w.webContents.isDestroyed(),
  ).length;
}
