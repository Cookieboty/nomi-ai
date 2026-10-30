const TIP_MARGIN = 8;
const TIP_GAP = 6;

/**
 * 悬停提示的 fixed 坐标，始终收在窗口内。
 * side：放在 boundary 右侧，放不下换左侧，再放不下落到 anchor 下方；
 * bottom：放在 anchor 下方，放不下换到上方。
 */
export function tipPosition(
  anchor: DOMRect,
  size: { width: number; height: number },
  placement: 'side' | 'bottom' = 'bottom',
  boundary: DOMRect = anchor,
): { left: number; top: number } {
  const { width: w, height: h } = size;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left: number;
  let top: number;
  if (placement === 'side' && boundary.right + TIP_GAP + w <= vw - TIP_MARGIN) {
    left = boundary.right + TIP_GAP;
    top = anchor.top + (anchor.height - h) / 2;
  } else if (placement === 'side' && boundary.left - TIP_GAP - w >= TIP_MARGIN) {
    left = boundary.left - TIP_GAP - w;
    top = anchor.top + (anchor.height - h) / 2;
  } else {
    // 短提示居中对齐触发元素，长提示从左缘开始
    left = w < anchor.width ? anchor.left + (anchor.width - w) / 2 : anchor.left;
    top = anchor.bottom + TIP_GAP;
    if (top + h > vh - TIP_MARGIN) top = anchor.top - TIP_GAP - h;
  }
  return {
    left: Math.max(TIP_MARGIN, Math.min(left, vw - w - TIP_MARGIN)),
    top: Math.max(TIP_MARGIN, Math.min(top, vh - h - TIP_MARGIN)),
  };
}
