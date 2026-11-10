/** A cancelable bubbling request lets the menu consume Escape before the chat body. */
export const PREVIEW_CHAT_DISMISS = 'preview-chat-dismiss';

export function dismissPreviewChat(): boolean {
  const header = document.querySelector('[data-preview-chat-header]');
  if (!header) return false;
  return !header.dispatchEvent(
    new Event(PREVIEW_CHAT_DISMISS, { bubbles: true, cancelable: true }),
  );
}

/** 收成按钮的预览对话要展开（选区菜单「问助手」等往输入框里填内容时发） */
export const PREVIEW_CHAT_OPEN = 'preview-chat-open';

export function openPreviewChat(): void {
  window.dispatchEvent(new Event(PREVIEW_CHAT_OPEN));
}
