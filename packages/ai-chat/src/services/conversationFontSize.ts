/** 会话正文字号；不改变输入框、侧栏或控件的设计令牌。 */
export const DEFAULT_CONVERSATION_FONT_SIZE = 14;
export const MIN_CONVERSATION_FONT_SIZE = 10;
export const MAX_CONVERSATION_FONT_SIZE = 20;
const KEY = 'ai-chat:conversationFontSize';
const listeners = new Set<() => void>();
let fallback = DEFAULT_CONVERSATION_FONT_SIZE;
let volatile = false;

function normalize(value: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_CONVERSATION_FONT_SIZE, Math.max(MIN_CONVERSATION_FONT_SIZE, Math.round(value)))
    : DEFAULT_CONVERSATION_FONT_SIZE;
}

export function getConversationFontSize(): number {
  if (volatile) return fallback;
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === null
      ? DEFAULT_CONVERSATION_FONT_SIZE
      : normalize(stored.trim() ? Number(stored) : NaN);
  } catch {
    return fallback;
  }
}

export function setConversationFontSize(value: number): void {
  fallback = normalize(value);
  try {
    window.localStorage.setItem(KEY, String(fallback));
    volatile = false;
  } catch {
    volatile = true;
    /* 存储不可用时，本窗口仍立即生效。 */
  }
  listeners.forEach((fn) => fn());
}

export function subscribeConversationFontSize(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}
