import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Measure against the single-row width even while the text occupies the full row.
 * This avoids oscillating between layouts when full-width text fits on one line. */
export function useCompactComposerLayout(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  enabled: boolean,
) {
  const [multiline, setMultiline] = useState(false);
  const measureRef = useRef<() => void>(() => {});

  // 量尺只建一次。每次按键都拆掉再建一个 textarea，会在组词中途改掉输入框旁边的 DOM，
  // WebView2 会丢掉组词光标。
  useLayoutEffect(() => {
    const input = ref.current;
    const wrapper = input?.parentElement;
    if (!enabled || !input || !wrapper) {
      setMultiline(false);
      measureRef.current = () => {};
      return;
    }
    const plus = wrapper.querySelector<HTMLElement>('[data-zone="left"] > :first-child');
    const right = wrapper.querySelector<HTMLElement>('[data-zone="right"]');
    const mirror = document.createElement('textarea');
    mirror.className = input.className;
    mirror.tabIndex = -1;
    mirror.setAttribute('aria-hidden', 'true');
    mirror.style.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;height:0;min-height:0;max-height:none;overflow:hidden;';
    wrapper.append(mirror);
    const measure = () => {
      if (input.dataset.composing === '1') return;
      const current = input.value;
      if (!current) {
        setMultiline(false);
        return;
      }
      const style = getComputedStyle(wrapper);
      const gap = Number.parseFloat(style.columnGap) || 0;
      const width =
        wrapper.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0) -
        (plus?.getBoundingClientRect().width ?? 0) -
        (right?.getBoundingClientRect().width ?? 0) -
        2 * gap;
      if (width <= 0) return;
      mirror.style.width = `${width}px`;
      mirror.value = current;
      const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight) || 24;
      setMultiline(mirror.scrollHeight > lineHeight * 1.5);
    };
    measureRef.current = measure;
    measure();
    const observer = new ResizeObserver(() => {
      if (input.dataset.composing === '1') return;
      measure();
    });
    observer.observe(wrapper);
    if (right) observer.observe(right);
    return () => {
      measureRef.current = () => {};
      observer.disconnect();
      mirror.remove();
    };
  }, [ref, enabled]);

  useLayoutEffect(() => {
    if (ref.current?.dataset.composing === '1') return;
    measureRef.current();
  }, [ref, value]);

  return enabled && multiline;
}
