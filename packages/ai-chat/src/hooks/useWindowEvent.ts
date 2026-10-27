import { useEffect, useRef } from 'react';

/** 订阅 window 上的自定义事件（如快捷键广播的「搜索对话」「重命名当前会话」）；回调始终用最新的一次 */
export function useWindowEvent(name: string, fn: () => void): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    const on = () => ref.current();
    window.addEventListener(name, on);
    return () => window.removeEventListener(name, on);
  }, [name]);
}
