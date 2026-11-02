/**
 * 素材库瀑布流：每张图按自己的宽高比显示，按时间顺序依次放进当前最矮的一列。
 * 用绝对定位而不是 CSS 多列：多列会按列从上到下排，读屏 / Tab 顺序和时间顺序对不上。
 */

/** 列的最小宽度（px）：窄窗口 1–2 列，宽屏 4–6 列 */
export const MIN_COLUMN = 200;

/** 「3:2」这类比例 → 宽 / 高；认不出时 null */
export function ratioOf(aspect: string | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect ?? '');
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

export function columnCount(width: number, gap: number, min = MIN_COLUMN): number {
  if (!(width > 0)) return 1;
  return Math.max(1, Math.floor((width + gap) / (min + gap)));
}

export interface Placed {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 摆放：`ratios[i]` 是第 i 张图的宽 / 高，`extra` 是图下方说明行的高度。
 * 极端比例夹在 1:3 到 3:1 之间，免得一张长图占满整列。
 */
export function layoutMasonry(
  ratios: number[],
  width: number,
  gap: number,
  extra = 0,
  min = MIN_COLUMN,
): { items: Placed[]; height: number; columnWidth: number } {
  const cols = columnCount(width, gap, min);
  const colW = cols > 0 && width > 0 ? (width - gap * (cols - 1)) / cols : min;
  const heights = new Array<number>(cols).fill(0);
  const items = ratios.map((r) => {
    const ratio = Math.min(3, Math.max(1 / 3, r > 0 && Number.isFinite(r) ? r : 1));
    let c = 0;
    for (let i = 1; i < cols; i++) if (heights[i]! < heights[c]!) c = i;
    const h = colW / ratio + extra;
    const placed = { left: c * (colW + gap), top: heights[c]!, width: colW, height: h };
    heights[c] = heights[c]! + h + gap;
    return placed;
  });
  const height = Math.max(0, ...heights.map((h) => h - gap));
  return { items, height: items.length ? height : 0, columnWidth: colW };
}
