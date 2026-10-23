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
