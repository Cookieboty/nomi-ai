import { useEffect, useRef, useState } from 'react';

/**
 * 把高频变化的文本按固定上限频率下发：首次 / 空闲后的第一次变化立即生效（leading），
 * 之后至少间隔 `intervalMs` 才再更新，最后一次变化一定会落下（trailing）。
 * `active` 为 false（回合结束）时不节流，直接返回最新文本。
 */
export function useThrottledText(text: string, intervalMs: number, active: boolean): string {
  const [shown, setShown] = useState(text);
  const latest = useRef(text);
  const lastEmit = useRef(0);
  const timer = useRef(0);
  useEffect(() => {
    latest.current = text;
  });

  useEffect(() => {
    if (!active) return;
    if (shown === text || timer.current) return;
    const wait = Math.max(0, lastEmit.current + intervalMs - Date.now());
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      lastEmit.current = Date.now();
      setShown(latest.current);
    }, wait);
  }, [text, shown, intervalMs, active]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = 0;
    },
    [],
  );

  return active ? shown : text;
}
