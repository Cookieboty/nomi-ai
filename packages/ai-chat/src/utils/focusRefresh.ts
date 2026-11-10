/** 窗口重新拿到焦点时重读的最短间隔：来回切窗口不每次都起一批 git 进程 */
export const FOCUS_REFRESH_MIN_MS = 5000;

/**
 * 窗口拿到焦点时调用 fn，但离上次因焦点调用不到 minMs 就跳过（切回窗口的连续 focus、
 * 在几个窗口之间来回切时不重复读）。返回取消订阅。
 */
export function onWindowFocus(fn: () => void, minMs = FOCUS_REFRESH_MIN_MS): () => void {
  let last = 0;
  const handler = () => {
    const now = Date.now();
    if (now - last < minMs) return;
    last = now;
    fn();
  };
  window.addEventListener('focus', handler);
  return () => window.removeEventListener('focus', handler);
}
