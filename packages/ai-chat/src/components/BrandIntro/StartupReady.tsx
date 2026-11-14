/** 数据到达并完成两帧排版后才释放开屏，避免欢迎页 / 会话内容先后闪现。 */
import { useEffect } from 'react';

import { introActive, startupBrandIntro, useBrandIntro } from './state';

export function StartupReady() {
  const { phase, mode, pending } = useBrandIntro();
  const ready = introActive(phase) && mode === 'app' && pending.length === 0;
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    let first = 0;
    let second = 0;
    void Promise.resolve(document.fonts?.ready).then(() => {
      if (!alive) return;
      first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => {
          if (alive) startupBrandIntro.appReady();
        });
      });
    });
    return () => {
      alive = false;
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [ready]);
  return null;
}
