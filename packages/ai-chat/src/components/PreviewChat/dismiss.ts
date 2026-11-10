/** A cancelable bubbling request lets the menu consume Escape before the chat body. */
export const PREVIEW_CHAT_DISMISS = 'preview-chat-dismiss';

export function dismissPreviewChat(): boolean {
  const header = document.querySelector('[data-preview-chat-header]');
  if (!header) return false;
  return !header.dispatchEvent(
    new Event(PREVIEW_CHAT_DISMISS, { bubbles: true, cancelable: true }),
  );
}
