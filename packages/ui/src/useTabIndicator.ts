import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface TabIndicatorRect {
  left: number;
  top: number;
  width: number;
  height: number;
  visible: boolean;
  animate: boolean;
}

const DEFAULT_SELECTOR = '[aria-selected="true"], [aria-checked="true"]';

/**
 * 测量标签容器内当前选中项的几何位置，供分段滑块或下划线指示条平滑跟随。
 * - 首次可见或容器隐藏恢复时直接就位（animate=false），避免从 (0,0) 飞入；
 * - 切换选中项时启用平滑过渡（animate=true）；
 * - 无布局引擎（如单测环境 offsetWidth=0）时 visible=false，自动回退按钮原生选中样式。
 */
export function useTabIndicator<E extends HTMLElement = HTMLDivElement>(
  activeKey: unknown,
  selector: string = DEFAULT_SELECTOR,
) {
  const listRef = useRef<E | null>(null);
  const settledRef = useRef(false);
  const prevKeyRef = useRef<unknown>(activeKey);
  const [indicator, setIndicator] = useState<TabIndicatorRect>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    visible: false,
    animate: false,
  });

  const measure = useCallback(
    (allowAnimate: boolean) => {
      const host = listRef.current;
      const activeEl = host?.querySelector<HTMLElement>(selector) ?? null;
      if (!host || !activeEl) {
        settledRef.current = false;
        setIndicator((prev) => (prev.visible ? { ...prev, visible: false, animate: false } : prev));
        return;
      }
      const width = activeEl.offsetWidth;
      const height = activeEl.offsetHeight;
      if (width <= 0 || height <= 0) {
        settledRef.current = false;
        setIndicator((prev) => (prev.visible ? { ...prev, visible: false, animate: false } : prev));
        return;
      }
      const left = activeEl.offsetLeft;
      const top = activeEl.offsetTop;
      const shouldAnimate = allowAnimate && settledRef.current;
      settledRef.current = true;
      setIndicator((prev) => {
        if (
          prev.visible &&
          prev.left === left &&
          prev.top === top &&
          prev.width === width &&
          prev.height === height &&
          prev.animate === shouldAnimate
        ) {
          return prev;
        }
        return { left, top, width, height, visible: true, animate: shouldAnimate };
      });
    },
    [selector],
  );

  useLayoutEffect(() => {
    const keyChanged = prevKeyRef.current !== activeKey;
    prevKeyRef.current = activeKey;
    measure(keyChanged);
  }, [activeKey, measure]);

  useLayoutEffect(() => {
    const host = listRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure(false));
    ro.observe(host);
    const activeEl = host.querySelector<HTMLElement>(selector);
    if (activeEl) ro.observe(activeEl);
    return () => ro.disconnect();
  }, [activeKey, measure, selector]);

  return { listRef, indicator, remeasure: measure };
}
