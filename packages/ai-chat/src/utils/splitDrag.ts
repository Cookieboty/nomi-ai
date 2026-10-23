/**
 * 分栏拖拽：捕获指针，在 window 上跟随 pointermove，直到 pointerup 或 pointercancel。
 * pointercancel（触摸被系统接管 / 窗口失焦等）不会再跟一个 pointerup，
 * 不处理会让监听器和拖拽状态一直留着，宽度跟着之后的任意指针移动。
 * onEnd 的 cancelled=true 时调用方应回到拖拽前的状态、不要持久化。
 */
export function startSplitDrag(opts: {
  el: Element;
  pointerId: number;
  onMove: (ev: PointerEvent) => void;
  onEnd: (cancelled: boolean) => void;
}): void {
  const { el, pointerId, onMove, onEnd } = opts;
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* 合成事件 / 指针已失效：退回 window 监听 */
  }
  const finish = (cancelled: boolean) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    try {
      if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    onEnd(cancelled);
  };
  const onUp = () => finish(false);
  const onCancel = () => finish(true);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}
