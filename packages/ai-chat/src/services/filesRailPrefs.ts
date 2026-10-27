/** 右栏（files rail）宽度与开关的本地偏好 */
export const FILES_RAIL_W_KEY = 'nomi.filesRailWidth';
export const FILES_RAIL_W_DEFAULT = 260;
export const FILES_RAIL_W_MIN = 200;
export const FILES_RAIL_W_MAX = 420;

export const FILES_RAIL_OPEN_KEY = 'nomi.filesRailOpen';

/** 右栏开关：默认收起，只有用户展开过才记住为展开 */
export function readFilesRailOpen(): boolean {
  try {
    return localStorage.getItem(FILES_RAIL_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function persistFilesRailOpen(open: boolean): void {
  try {
    localStorage.setItem(FILES_RAIL_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function readFilesRailWidth(): number {
  try {
    const n = Number(localStorage.getItem(FILES_RAIL_W_KEY));
    if (Number.isFinite(n)) {
      return Math.min(FILES_RAIL_W_MAX, Math.max(FILES_RAIL_W_MIN, Math.round(n)));
    }
  } catch {
    /* ignore */
  }
  return FILES_RAIL_W_DEFAULT;
}
