import type { BrowserWindow, Rectangle } from 'electron';

/** Windows 分数 DPI 下按读回的误差校正尺寸，不假定固定 DPI 或边框大小。 */
export function setWindowBounds(
  win: BrowserWindow,
  bounds: Rectangle,
  platform: NodeJS.Platform = process.platform,
): void {
  // Windows / GTK 的不可缩放窗口会锁住首次尺寸；程序化缩放时临时放开。
  const locked = (platform === 'win32' || platform === 'linux') && !win.isResizable();
  if (locked) win.setResizable(true);
  try {
    let requested = { ...bounds };
    for (let n = 0; n < (platform === 'win32' ? 3 : 1); n++) {
      win.setBounds(requested);
      if (platform !== 'win32') break;
      const actual = win.getBounds();
      const dx = actual.x - bounds.x,
        dy = actual.y - bounds.y;
      const dw = actual.width - bounds.width,
        dh = actual.height - bounds.height;
      if (![dx, dy, dw, dh].some(Boolean)) break;
      // 系统最小尺寸 / 工作区限制不应触发大幅反向修正。
      if ([dx, dy, dw, dh].some((v) => Math.abs(v) > 8)) break;
      requested = {
        x: requested.x - dx,
        y: requested.y - dy,
        width: Math.max(1, requested.width - dw),
        height: Math.max(1, requested.height - dh),
      };
    }
  } finally {
    if (locked) win.setResizable(false);
  }
}
