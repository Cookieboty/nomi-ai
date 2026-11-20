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

/** 写入过用户拖动结果的标记：有它之后，连旧默认 440 也算用户选的，原样记住 */
export const CHAT_COL_W_USER_KEY = 'nomi.chatColumnWidth.user';

/**
 * 旧版默认宽度（px）。读入 localStorage 时：没有「用户拖动过」标记、且值恰好是旧默认 440，
 * 才迁移到 CHAT_COL_W_DEFAULT（纠正「一开变更 chat 就剩一条」的旧默认）。
 * 只认这个精确值：其它宽度（包括标记出现之前就拖过的）都原样保留，不重置用户的选择。
 */
export const CHAT_COL_W_LEGACY_DEFAULT = 440;

export function clampChatColumnWidth(n: number): number {
  return Math.min(CHAT_COL_W_MAX, Math.max(CHAT_COL_W_MIN, Math.round(n)));
}

export function readChatColumnWidth(): number {
  try {
    const raw = localStorage.getItem(CHAT_COL_W_KEY);
    // 没存过（null / 空串）不能当 0 处理，否则会被夹到 MIN
    const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
    if (Number.isFinite(n)) {
      const rounded = Math.round(n);
      if (
        rounded === CHAT_COL_W_LEGACY_DEFAULT &&
        localStorage.getItem(CHAT_COL_W_USER_KEY) !== '1'
      ) {
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
    localStorage.setItem(CHAT_COL_W_USER_KEY, '1');
  } catch {
    /* ignore */
  }
}

/** 分栏比例持久化键（0~1，表示对话列占主区可用宽度的比例） */
export const CHAT_COL_RATIO_KEY = 'nomi.chatColumnRatio';

/** 首次打开默认各占一半（50% : 50%） */
export const CHAT_COL_RATIO_DEFAULT = 0.5;

/** 拖动比例下限 / 上限 */
export const CHAT_COL_RATIO_MIN = 0.2;
export const CHAT_COL_RATIO_MAX = 0.8;

export function clampChatColumnRatio(n: number): number {
  const clamped = Math.min(CHAT_COL_RATIO_MAX, Math.max(CHAT_COL_RATIO_MIN, n));
  return Math.round(clamped * 10000) / 10000;
}

export function readChatColumnRatio(): number {
  try {
    const raw = localStorage.getItem(CHAT_COL_RATIO_KEY);
    const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
    if (Number.isFinite(n)) return clampChatColumnRatio(n);
  } catch {
    /* ignore */
  }
  return CHAT_COL_RATIO_DEFAULT;
}

export function persistChatColumnRatio(r: number): void {
  try {
    localStorage.setItem(CHAT_COL_RATIO_KEY, String(clampChatColumnRatio(r)));
  } catch {
    /* ignore */
  }
}
