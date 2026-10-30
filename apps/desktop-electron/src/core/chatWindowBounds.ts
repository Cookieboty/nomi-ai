/**
 * 对话窗口（主界面）的位置与大小：关闭时记下，下次打开时恢复（config.json 的 chatWindowBounds）。
 * 恢复前按当前的显示器校正：保存的位置已经不在任何屏幕上（拔了外接屏、改了分辨率）就居中到主屏，
 * 大小夹在最小尺寸与所在屏幕的工作区之间。纯函数，便于单测。
 */
import type { Rectangle } from 'electron';

export interface SavedChatBounds extends Rectangle {
  /** 关闭时是最大化的：恢复为最大化，取消最大化后回到 x/y/width/height */
  maximized?: boolean;
}

/** 至少要有这么大一块落在某个屏幕的工作区里，才算「还在屏幕上」 */
const VISIBLE_MIN = 120;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isSavedChatBounds(v: unknown): v is SavedChatBounds {
  const o = v as Partial<SavedChatBounds> | null;
  return !!o && finite(o.x) && finite(o.y) && finite(o.width) && finite(o.height);
}

function overlap(a: Rectangle, b: Rectangle): { w: number; h: number } {
  return {
    w: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * 算出这次打开用的位置与大小。saved 无效时返回 null（调用方用默认的居中尺寸）。
 * workAreas[0] 视为主屏。
 */
export function restoreChatBounds(
  saved: unknown,
  workAreas: readonly Rectangle[],
  min: { width: number; height: number },
): SavedChatBounds | null {
  if (!isSavedChatBounds(saved) || !workAreas.length) return null;
  // 落在哪块屏上（重叠足够大）；都不在就放到主屏
  const host =
    workAreas.find((a) => {
      const o = overlap(saved, a);
      return o.w >= VISIBLE_MIN && o.h >= VISIBLE_MIN;
    }) ?? null;
  const area = host ?? workAreas[0]!;
  const width = Math.round(Math.min(area.width, Math.max(min.width, saved.width)));
  const height = Math.round(Math.min(area.height, Math.max(min.height, saved.height)));
  let x = Math.round(host ? saved.x : area.x + (area.width - width) / 2);
  let y = Math.round(host ? saved.y : area.y + (area.height - height) / 2);
  // 标题栏必须在工作区里（拖得回来）；整体也不超出工作区右下
  x = Math.min(Math.max(x, area.x), area.x + area.width - width);
  y = Math.min(Math.max(y, area.y), area.y + area.height - height);
  return { x, y, width, height, ...(saved.maximized ? { maximized: true } : {}) };
}
