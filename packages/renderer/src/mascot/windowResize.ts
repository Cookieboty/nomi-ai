/**
 * 看板娘窗口被主进程缩放（Ctrl/⌘+滚轮 / 菜单 / 设置滑块）后通知交互层：
 * 角色包围盒与头部框要尽快重新上报（工具栏槽位、气泡避让、主进程物理脚底线），
 * 而不是等下一个 500ms 周期。节流 120ms，让画布先按新尺寸画出一帧再取几何。
 */
export function onWindowResized(cb: () => void, delayMs = 120): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handler = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      cb();
    }, delayMs);
  };
  window.addEventListener('resize', handler);
  return () => {
    window.removeEventListener('resize', handler);
    if (timer) clearTimeout(timer);
  };
}
