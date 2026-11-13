/**
 * 让 textarea 走非受控：文本由 DOM 自己持有，React 只在外部（发送、切会话、补全、语音、
 * 历史找回）真的改了值、且不在输入法组字时写回。
 *
 * 为什么不用受控 `value`：中文组字期间每敲一个拼音，都会触发一次 input 事件；只要 React
 * 在这中间把 `value` 写回旧值，组字内容就被覆盖（越打越少），同时自动高度在半路重排，
 * WebView2 的候选条会离开光标。非受控从根上避免了这两件事。
 */
import { useLayoutEffect, type RefObject } from 'react';

export function useUncontrolledValue(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  composing: () => boolean,
  clearComposing: (el: HTMLTextAreaElement) => void,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.value === value) return;
    // 外部清空（发送、切会话、清草稿）不能被组字标记拦着，否则旧文字会留在框里
    if (value === '') {
      clearComposing(el);
      el.value = '';
      return;
    }
    if (composing()) return;
    el.value = value;
  }, [ref, value, composing, clearComposing]);
}
