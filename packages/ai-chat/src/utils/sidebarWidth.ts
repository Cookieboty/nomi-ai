/** Left conversation panel only; the fixed navigation rail stays 52px wide. */
export const SIDEBAR_WIDTH_KEY = 'nomi.sidebarPanelWidth';
export const SIDEBAR_WIDTH_DEFAULT = 260;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 420;

export function clampSidebarWidth(width: number): number {
  return Number.isFinite(width)
    ? Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)))
    : SIDEBAR_WIDTH_DEFAULT;
}

export function readSidebarWidth(): number {
  try {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (saved !== null && saved.trim() !== '') return clampSidebarWidth(Number(saved));
  } catch {
    /* Storage may be unavailable; resizing still works for this window. */
  }
  return SIDEBAR_WIDTH_DEFAULT;
}

export function persistSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
  } catch {
    /* ignore */
  }
}
