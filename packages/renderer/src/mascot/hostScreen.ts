/**
 * 窗口在屏幕上的位置 + 所在显示器的工作区：工具栏 / 气泡 / 确认框据此判断贴边换边。
 * 优先用内核推来的 `mascot.screen`（按真实窗口坐标算）；WKWebView 里内核挪窗后 window.screenX
 * 不一定更新，只在还没收到内核数据时（浏览器预览、刚启动）回退到 window.screen*。
 */
export interface HostScreen {
  winX: number;
  winY: number;
  availLeft: number;
  availWidth: number;
}

let pushed: HostScreen | null = null;
const listeners = new Set<() => void>();

export function setHostScreen(next: HostScreen): void {
  if (
    pushed &&
    pushed.winX === next.winX &&
    pushed.winY === next.winY &&
    pushed.availLeft === next.availLeft &&
    pushed.availWidth === next.availWidth
  )
    return;
  pushed = next;
  for (const fn of [...listeners]) fn();
}

export function hostScreen(): HostScreen {
  if (pushed) return pushed;
  const s = window.screen as Screen & { availLeft?: number };
  return {
    winX: window.screenX,
    winY: window.screenY,
    availLeft: s.availLeft ?? 0,
    availWidth: s.availWidth,
  };
}

/** 内核推来的位置变化时回调（返回取消订阅） */
export function subscribeHostScreen(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 测试用 */
export function resetHostScreen(): void {
  pushed = null;
  listeners.clear();
}
