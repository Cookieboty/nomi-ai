/** 数据到达并完成两帧排版后才释放开屏，避免欢迎页 / 会话内容先后闪现。 */
import { useEffect } from 'react';

import { introActive, startupBrandIntro, useBrandIntro } from './state';

/** WebView 里 document.fonts.ready 偶尔一直不 resolve：最多等这么久就继续。 */
export const FONTS_READY_TIMEOUT_MS = 1500;
/** 窗口不可见时 requestAnimationFrame 不触发：两帧没来就按时间兜底。 */
export const LAYOUT_FRAME_FALLBACK_MS = 300;

export function StartupReady() {
  const { phase, mode, pending, ready: released } = useBrandIntro();
  // 用 !released 参与判断：揭开后又有加载任务开始并在同一批次结束时，依赖也会变化，重新等排版
  const ready = introActive(phase) && mode === 'app' && pending.length === 0 && !released;
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    let first = 0;
    let second = 0;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let fontsTimer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (!alive) return;
      alive = false;
      startupBrandIntro.appReady();
    };
    const fonts = new Promise<void>((resolve) => {
      fontsTimer = setTimeout(resolve, FONTS_READY_TIMEOUT_MS);
      void Promise.resolve(document.fonts?.ready).then(
        () => resolve(),
        () => resolve(),
      );
    });
    void fonts.then(() => {
      if (!alive) return;
      fallback = setTimeout(done, LAYOUT_FRAME_FALLBACK_MS);
      first = requestAnimationFrame(() => {
        second = requestAnimationFrame(done);
      });
    });
    return () => {
      alive = false;
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      clearTimeout(fallback);
      clearTimeout(fontsTimer);
    };
  }, [ready]);
  return null;
}
