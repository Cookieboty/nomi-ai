/**
 * 会话正文字号：三档（普通 / 较大 / 特大），默认较大（14，与原来的默认一样）；不改变输入框、侧栏或控件的设计令牌。
 * 以前存的任意值（10–20px）就近落到一档（正好在两档中间时取大的）。
 */
export const CONVERSATION_FONT_SIZES = [
  { size: 12, label: 'ui.chat-settings.conversation-font-normal' },
  { size: 14, label: 'ui.chat-settings.conversation-font-large' },
  { size: 16, label: 'ui.chat-settings.conversation-font-xlarge' },
] as const;
export const DEFAULT_CONVERSATION_FONT_SIZE = 14;
const KEY = 'ai-chat:conversationFontSize';
const listeners = new Set<() => void>();
let fallback = DEFAULT_CONVERSATION_FONT_SIZE;
let volatile = false;

function normalize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONVERSATION_FONT_SIZE;
  let best: number = CONVERSATION_FONT_SIZES[0].size;
  for (const { size } of CONVERSATION_FONT_SIZES) {
    if (Math.abs(size - value) <= Math.abs(best - value)) best = size;
  }
  return best;
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
