/**
 * 输入框的组字（IME）状态。两条硬要求，都来自 WebView2 的真实表现：
 *
 * 1. 组字期间绝不让 React 改写文本或高度 —— 否则组字内容被覆盖（越打越少），
 *    自动高度在半路重排，候选条离开光标；
 * 2. 它有时只发 compositionstart、不发 compositionend（切走焦点、换输入法、重挂载），
 *    所以要能在失焦或下一次普通输入时自愈，否则输入框会一直打不进字。
 */
import { useCallback, useRef, type CompositionEvent, type RefObject } from 'react';

import { isCompositionInput } from './composing';

export function useComposing(
  ref: RefObject<HTMLTextAreaElement | null>,
  /** 组字上屏后提交文本（写回受控镜像并记光标） */
  commit: (el: HTMLTextAreaElement) => void,
) {
  const composingRef = useRef(false);

  const clearComposing = useCallback((el: HTMLTextAreaElement | null) => {
    if (!composingRef.current) return;
    composingRef.current = false;
    delete el?.dataset.composing;
  }, []);

  /** 记上组字标记：标记在时自动高度只增不减，不做 0px 往返测量。 */
  const markComposing = useCallback((el: HTMLTextAreaElement) => {
    composingRef.current = true;
    el.dataset.composing = '1';
  }, []);

  // 不 setState：组字开始时重渲染会把文本写回输入框，WebView2 会丢掉组词。
  const onCompositionStart = useCallback(
    (e: CompositionEvent<HTMLTextAreaElement>) => markComposing(e.currentTarget),
    [markComposing],
  );

  const onCompositionEnd = useCallback(
    (e: CompositionEvent<HTMLTextAreaElement>) => {
      composingRef.current = false;
      delete e.currentTarget.dataset.composing;
      commit(e.currentTarget);
    },
    [commit],
  );

  /** 这次 input 是不是输入法在组字（见 composing.ts 的说明）。 */
  const isCompositionEvent = useCallback(
    (native: InputEvent) => isCompositionInput(native, composingRef.current),
    [],
  );

  /** 现在是不是在组字（含漏了 compositionend、标记还挂着的情形）。 */
  const isComposing = useCallback(
    () => composingRef.current || ref.current?.dataset.composing === '1',
    [ref],
  );

  return {
    composingRef,
    clearComposing,
    markComposing,
    onCompositionStart,
    onCompositionEnd,
    isCompositionEvent,
    isComposing,
  };
}
