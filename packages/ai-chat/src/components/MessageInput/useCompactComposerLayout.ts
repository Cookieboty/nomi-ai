import { useLayoutEffect, useState, type RefObject } from 'react';

/** Measure against the single-row width even while the text occupies the full row.
 * This avoids oscillating between layouts when full-width text fits on one line. */
export function useCompactComposerLayout(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  enabled: boolean,
) {
  const [multiline, setMultiline] = useState(false);
  useLayoutEffect(() => {
    const input = ref.current;
    const wrapper = input?.parentElement;
    if (!enabled || !input || !wrapper) return;
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
      if (!value) {
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
      mirror.value = value;
      const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight) || 24;
      setMultiline(mirror.scrollHeight > lineHeight * 1.5);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    if (right) observer.observe(right);
    return () => {
      observer.disconnect();
      mirror.remove();
    };
  }, [ref, value, enabled]);
  return enabled && multiline;
}
