/** 事件来自可编辑控件（输入框 / 文本域 / 下拉 / contenteditable） */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * window 级 Esc 监听（中栏 Diff / 文件预览）该不该忽略这次按键：
 * 已被别处处理（preventDefault，如输入框关斜杠菜单）、输入法组词中、
 * 或来自 `owns` 之外的可编辑控件（聊天输入框里按 Esc 不应关掉中间的 Diff）。
 */
export function shouldIgnoreEscape(
  e: Pick<KeyboardEvent, 'defaultPrevented' | 'isComposing' | 'target'>,
  owns?: (target: EventTarget | null) => boolean,
): boolean {
  if (e.defaultPrevented || e.isComposing) return true;
  return isEditableTarget(e.target) && !owns?.(e.target);
}

/**
 * 输入法正在组词（这次按键是给输入法的，不是给输入框的）。macOS 的 WebKit（Go 版的 WKWebView、Safari）
 * 在确认上屏的那次回车之前就发出 compositionend，keydown 里 isComposing 已是 false，只有 keyCode 仍是 229；
 * 所以「回车发送」等都要用它判断，不能只看 isComposing。
 */
export function isImeComposing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return e.isComposing === true || e.keyCode === 229;
}

/** Home/End 定位当前逻辑行；Shift 扩展选区，Ctrl/Meta 定位全文首尾。 */
export function moveTextareaToLineBoundary(
  el: HTMLTextAreaElement,
  key: 'Home' | 'End',
  extend: boolean,
  documentBoundary: boolean,
): void {
  const { value, selectionStart: start, selectionEnd: end, selectionDirection: direction } = el;
  const backward = direction === 'backward';
  const anchor = backward ? end : start;
  const focus = extend ? (backward ? start : end) : key === 'Home' ? start : end;
  const nextBreak = value.indexOf('\n', focus);
  const target = documentBoundary
    ? key === 'Home'
      ? 0
      : value.length
    : key === 'Home'
      ? focus === 0
        ? 0
        : value.lastIndexOf('\n', focus - 1) + 1
      : nextBreak < 0
        ? value.length
        : nextBreak;
  if (extend) {
    el.setSelectionRange(
      Math.min(anchor, target),
      Math.max(anchor, target),
      target < anchor ? 'backward' : 'forward',
    );
  } else {
    el.setSelectionRange(target, target);
  }
}
