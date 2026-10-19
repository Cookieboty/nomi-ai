/**
 * 对话窗口的一体化标题栏：
 * - macOS：titleBarStyle 'hiddenInset'，红绿灯嵌进深色头部（页面顶部 38px 是可拖动区域）
 * - Windows / Linux：无边框 + 原生 Window Controls Overlay（最小化 / 最大化 / 关闭由系统绘制，
 *   颜色跟随主题），页面顶部 36px 可拖动
 */
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export type ChromeTheme = 'mist' | 'graphite' | 'ink' | 'cream' | 'sunset';

/** 与 packages/ui/src/tokens.css 中各主题的 --cd-color-bg / --cd-color-text 保持一致 */
export const THEME_CHROME: Record<ChromeTheme, { bg: string; fg: string }> = {
  mist: { bg: '#0a0f1a', fg: '#e8eef7' },
  graphite: { bg: '#0f0f11', fg: '#ededef' },
  ink: { bg: '#1a1917', fg: '#ece8e1' },
  cream: { bg: '#fcefe1', fg: '#33291f' },
  sunset: { bg: '#fff6ec', fg: '#3d2918' },
};

export const TITLEBAR_HEIGHT = { mac: 38, other: 36 } as const;

export function titleBarOptions(
  platform: NodeJS.Platform,
  theme: ChromeTheme,
): Partial<BrowserWindowConstructorOptions> {
  const c = THEME_CHROME[theme] ?? THEME_CHROME.ink;
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 12 },
      backgroundColor: c.bg,
    };
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.bg, symbolColor: c.fg, height: TITLEBAR_HEIGHT.other },
    backgroundColor: c.bg,
  };
}

/** 主题切换时更新窗口底色与 Windows / Linux 的原生按钮配色 */
export function applyTitleBarTheme(
  win: BrowserWindow,
  theme: ChromeTheme,
  platform: NodeJS.Platform = process.platform,
): void {
  const c = THEME_CHROME[theme] ?? THEME_CHROME.ink;
  if (win.isDestroyed()) return;
  win.setBackgroundColor(c.bg);
  if (platform !== 'darwin' && typeof win.setTitleBarOverlay === 'function') {
    try {
      win.setTitleBarOverlay({ color: c.bg, symbolColor: c.fg, height: TITLEBAR_HEIGHT.other });
    } catch {
      /* 窗口不是用 titleBarOverlay 创建的 */
    }
  }
}
