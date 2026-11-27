/**
 * 会话面板的本地偏好：左右比例，以及「拆分时两边各是哪个会话」（重启后会话还在就恢复拆分）。
 * 只记会话键，不记消息：会话被删 / 归档 / CLI 标签关掉时恢复不出来，退回单面板。
 */
import {
  clampPaneRatio,
  MAX_SESSION_PANES,
  PANE_RATIO_DEFAULT,
  type SessionPane,
} from '../utils/sessionPanes';

/** 左右比例（0~1，左面板占两个面板可用宽度的比例） */
export const PANE_RATIO_KEY = 'nomi.sessionPanes.ratio';

/** 拆分快照：左右两个面板的会话键（右边为 null = 没拆分） */
export const PANE_SPLIT_KEY = 'nomi.sessionPanes.split';

export interface PaneSplitSnapshot {
  left: string | null;
  right: string | null;
}

export function readPaneRatio(): number {
  try {
    const raw = localStorage.getItem(PANE_RATIO_KEY);
    const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
    if (Number.isFinite(n)) return clampPaneRatio(n);
  } catch {
    /* ignore */
  }
  return PANE_RATIO_DEFAULT;
}

export function persistPaneRatio(ratio: number): void {
  try {
    localStorage.setItem(PANE_RATIO_KEY, String(clampPaneRatio(ratio)));
  } catch {
    /* ignore */
  }
}

function isKey(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && v.length > 0);
}

/**
 * 读拆分快照：没有 / 坏数据 / 两边同一个会话（同一会话不能同时出现在两个面板）都当没拆分。
 * 左边可以是 null（左面板开着空会话、右边是一个会话）。
 */
export function readPaneSplit(): PaneSplitSnapshot | null {
  try {
    const raw = localStorage.getItem(PANE_SPLIT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PaneSplitSnapshot> | null;
    if (!v || typeof v !== 'object') return null;
    if (!isKey(v.left) || !isKey(v.right)) return null;
    if (!v.left || !v.right || v.right === v.left) return null;
    return { left: v.left, right: v.right };
  } catch {
    return null;
  }
}

/** 只有拆分（两个面板且两边各有一个不同会话）才写；到单面板 / 含空面板 / 两边同一会话时清掉，下次启动是单面板 */
export function persistPaneSplit(panes: readonly SessionPane[]): void {
  try {
    const [left, right] = panes;
    if (
      panes.length < MAX_SESSION_PANES ||
      !left?.sessionKey ||
      !right?.sessionKey ||
      right.sessionKey === left.sessionKey
    ) {
      localStorage.removeItem(PANE_SPLIT_KEY);
      return;
    }
    const snapshot: PaneSplitSnapshot = {
      left: left?.sessionKey ?? null,
      right: right.sessionKey,
    };
    localStorage.setItem(PANE_SPLIT_KEY, JSON.stringify(snapshot));
  } catch {
    /* ignore */
  }
}
