/**
 * 左侧会话面板（导航栏右边那一栏）的宽度：拖动分割线调整，松手记住，双击复位。
 * 实际宽度在 App.css 的 `--sidebar-panel-w` 里再按窗口宽度封顶，窄窗口下不挤掉右边各栏。
 */
export const SIDEBAR_W_KEY = 'nomi.sidebarPanelWidth';
export const SIDEBAR_W_DEFAULT = 260;
export const SIDEBAR_W_MIN = 220;
export const SIDEBAR_W_MAX = 360;

export function clampSidebarWidth(n: number): number {
  return Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, Math.round(n)));
}

export function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_W_KEY);
    // 没存过（null / 空串）不能当 0，否则会被夹到 MIN
    const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
    if (Number.isFinite(n)) return clampSidebarWidth(n);
  } catch {
    /* ignore */
  }
  return SIDEBAR_W_DEFAULT;
}

export function persistSidebarWidth(w: number): void {
  try {
    localStorage.setItem(SIDEBAR_W_KEY, String(clampSidebarWidth(w)));
  } catch {
    /* ignore */
  }
}
