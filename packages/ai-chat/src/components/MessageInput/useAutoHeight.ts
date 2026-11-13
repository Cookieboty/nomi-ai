/**
 * 发文框随内容长高（Codex 式）：空着时一行，超过上限后框内滚动。
 * 列向 flex 里 flex:1 的基准高度是 0，行内 height 不生效，所以按内容写回 style.height。
 * 宽度变了（窗口缩放、侧栏展开动画、从整页切回）也重算：窄宽度下量到的高度不能一直留着。
 */
import { useLayoutEffect, type RefObject } from 'react';

/**
 * 按内容写回高度。组词中（data-composing）不能把高度打成 0：WebView2 会把
 * 输入法候选条的光标矩形算到窗口左上角，组词文字也不再画出来。
 */
export function fitTextarea(el: HTMLTextAreaElement, min: number, max: number): void {
  el.style.maxHeight = `${max}px`;
  // 空着就是一行：不量占位文字（窄宽度下它会折成好几行把框撑高）
  if (!el.value) {
    el.style.height = `${min}px`;
    return;
  }
  const next = Math.min(Math.max(el.scrollHeight, min), max);
  if (el.dataset.composing === '1') {
    const current = Number.parseFloat(el.style.height);
    if (!Number.isFinite(current) || next > current) el.style.height = `${next}px`;
    return;
  }
  // flex 子项的 scrollHeight 等于当前高度，先收到 0 才能量出内容高度。组词时不做这一步。
  el.style.height = '0px';
  el.style.height = `${Math.min(Math.max(el.scrollHeight, min), max)}px`;
}

export function useAutoHeight(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  min: number,
  max: number,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      fitTextarea(el, min, max);
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, value, min, max]);
}
