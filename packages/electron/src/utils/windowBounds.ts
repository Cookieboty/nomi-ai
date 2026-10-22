import type { BrowserWindow, Rectangle } from 'electron';

export type SetWindowBoundsOptions = {
  /**
   * When false, skip the Windows / Linux setResizable unlock dance.
   * Use for high-frequency position-only moves (drag / physics) when size is already correct.
   * Default true.
   */
  unlockSize?: boolean;
};

/** Windows 分数 DPI 下按读回的误差校正尺寸，不假定固定 DPI 或边框大小。 */
export function setWindowBounds(
  win: BrowserWindow,
  bounds: Rectangle,
  platform: NodeJS.Platform = process.platform,
  opts: SetWindowBoundsOptions = {},
): void {
  const unlock = opts.unlockSize !== false;
  // Windows / GTK 的不可缩放窗口会锁住首次尺寸；程序化缩放时临时放开。
  const locked = unlock && (platform === 'win32' || platform === 'linux') && !win.isResizable();
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

/**
 * Move the mascot window. On Windows, setPosition alone grows a non-resizable
 * transparent window under fractional DPI; we must keep the intended size in
 * setBounds. Calling the full unlock+correct path every 60 Hz tick (drag /
 * physics) flaps setResizable and causes accumulating stutter — only unlock
 * when the size has actually drifted.
 */
export function moveWindowTo(
  win: BrowserWindow,
  x: number,
  y: number,
  size: { width: number; height: number },
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    win.setPosition(x, y);
    return;
  }
  const actual = win.getBounds();
  const drifted =
    Math.abs(actual.width - size.width) > 1 || Math.abs(actual.height - size.height) > 1;
  if (drifted) {
    setWindowBounds(win, { x, y, ...size }, platform);
  } else {
    // Position-only: one setBounds, no setResizable flap (root cause of Win drag jank).
    setWindowBounds(win, { x, y, width: actual.width, height: actual.height }, platform, {
      unlockSize: false,
    });
  }
}
