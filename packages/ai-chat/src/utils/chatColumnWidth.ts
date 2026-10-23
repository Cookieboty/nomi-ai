/**
 * 中栏 Diff（workbench）打开时对话列宽度。
 * 对话是主阅读区，Diff 为旁栏：默认 chat 占主要宽度，Diff flex:1 吃剩余。
 */
export const CHAT_COL_W_KEY = 'nomi.chatColumnWidth';

/** 双击分割线恢复的默认宽度（px）；对齐「对话为主、Diff 旁栏」 */
export const CHAT_COL_W_DEFAULT = 720;

/** 拖动下限 */
export const CHAT_COL_W_MIN = 360;

/** 拖动上限 */
export const CHAT_COL_W_MAX = 1100;

/**
 * 读入 localStorage 时：低于此视为历史过窄默认（旧默认 440 等），回退到 CHAT_COL_W_DEFAULT。
 * 用户仍可拖到 MIN；仅纠正「一开变更 chat 就剩一条」的坏默认。
 */
export const CHAT_COL_W_TOO_NARROW = 520;

export function clampChatColumnWidth(n: number): number {
  return Math.min(CHAT_COL_W_MAX, Math.max(CHAT_COL_W_MIN, Math.round(n)));
}

export function readChatColumnWidth(): number {
  try {
    const n = Number(localStorage.getItem(CHAT_COL_W_KEY));
    if (Number.isFinite(n)) {
      const rounded = Math.round(n);
      if (rounded < CHAT_COL_W_TOO_NARROW) {
        try {
          localStorage.setItem(CHAT_COL_W_KEY, String(CHAT_COL_W_DEFAULT));
        } catch {
          /* ignore */
        }
        return CHAT_COL_W_DEFAULT;
      }
      return clampChatColumnWidth(rounded);
    }
  } catch {
    /* ignore */
  }
  return CHAT_COL_W_DEFAULT;
}

export function persistChatColumnWidth(w: number): void {
  try {
    localStorage.setItem(CHAT_COL_W_KEY, String(clampChatColumnWidth(w)));
  } catch {
    /* ignore */
  }
}
