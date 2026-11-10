import { useEffect, useState } from 'react';

/** 收起动画的时长（与 base.css 里 cd-motion-* 的退出动画一致） */
export const EXIT_MS = 150;

function motionAllowed(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches === true;
  } catch {
    return false;
  }
}

/**
 * 收起时先放完退出动画再卸载：value 变成空（null / false）后，继续返回上一次的值 ms 毫秒，
 * 同时 closing = true（给元素加 data-closing，配合 cd-motion-* 类）。
 * 减少动态效果或环境不支持时立即卸载。
 */
export function usePresence<T>(
  value: T | null | undefined | false,
  ms: number = EXIT_MS,
): { value: T | null; closing: boolean } {
  const [last, setLast] = useState<T | null>(value || null);
  const [leaving, setLeaving] = useState(false);
  // 渲染期同步：打开 / 换值就记下；关掉时决定是放退出动画还是直接卸载
  if (value) {
    if (value !== last) setLast(value);
    if (leaving) setLeaving(false);
  } else if (last !== null && !leaving) {
    if (motionAllowed()) setLeaving(true);
    else setLast(null);
  }
  useEffect(() => {
    if (!leaving) return;
    const id = window.setTimeout(() => {
      setLeaving(false);
      setLast(null);
    }, ms);
    return () => window.clearTimeout(id);
  }, [leaving, ms]);
  if (value) return { value, closing: false };
  return { value: leaving ? last : null, closing: leaving };
}
