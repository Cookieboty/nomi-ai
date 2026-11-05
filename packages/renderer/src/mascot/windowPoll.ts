/**
 * 窗口位置轮询：窗口被拖到屏幕边缘 / 物理移动时没有事件，只能定时看一眼。
 * 为了不每次都重新量 DOM：
 * - 页面隐藏（document.hidden）时不跑，重新可见时立即算一次；
 * - active() 为假（如气泡没有文字）时跳过；
 * - 窗口位置 / 尺寸 / 可用屏幕都没变时跳过，但每 forceEvery 次仍完整算一次（兜底没有事件的其它变化）。
 */
export function startWindowPoll(
  compute: () => void,
  intervalMs: number,
  opts: { active?: () => boolean; forceEvery?: number } = {},
): () => void {
  const forceEvery = Math.max(1, opts.forceEvery ?? 5);
  let last = '';
  let ticks = 0;
  const signature = () => {
    const s = window.screen as Screen & { availLeft?: number; availTop?: number };
    return [
      window.screenX,
      window.screenY,
      window.innerWidth,
      window.innerHeight,
      s.availLeft ?? 0,
      s.availTop ?? 0,
      s.availWidth,
      s.availHeight,
    ].join(',');
  };
  const tick = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (opts.active && !opts.active()) return;
    const sig = signature();
    ticks += 1;
    if (sig === last && ticks % forceEvery !== 0) return;
    last = sig;
    compute();
  };
  const onVisibility = () => {
    if (!document.hidden) {
      last = signature();
      compute();
    }
  };
  last = signature();
  const timer = setInterval(tick, intervalMs);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
