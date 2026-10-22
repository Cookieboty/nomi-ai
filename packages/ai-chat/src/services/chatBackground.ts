/**
 * 对话主面板背景：主进程 chat-bg:* 持久化；无 IPC 时落 localStorage（浏览器 / 单测）。
 */
import type { CSSProperties } from 'react';

export type ChatBgMode = 'default' | 'solid' | 'image';

export interface ChatBackgroundState {
  mode: ChatBgMode;
  solidColor: string;
  imageUrl: string | null;
  blur: number;
  opacity: number;
}

export const DEFAULT_CHAT_BG: ChatBackgroundState = {
  mode: 'default',
  solidColor: '#fff9f1',
  imageUrl: null,
  blur: 0,
  opacity: 0.35,
};

const KEY = 'cd.chatBackground';
const MODES: ChatBgMode[] = ['default', 'solid', 'image'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function sanitizeChatBg(raw: unknown): ChatBackgroundState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<ChatBackgroundState>;
  const mode = MODES.includes(o.mode as ChatBgMode) ? (o.mode as ChatBgMode) : 'default';
  const solidColor =
    typeof o.solidColor === 'string' && HEX.test(o.solidColor)
      ? o.solidColor
      : DEFAULT_CHAT_BG.solidColor;
  const imageUrl =
    typeof o.imageUrl === 'string' &&
    (o.imageUrl.startsWith('chat-asset://') ||
      o.imageUrl.startsWith('data:') ||
      o.imageUrl.startsWith('blob:'))
      ? o.imageUrl
      : null;
  const blur = typeof o.blur === 'number' && Number.isFinite(o.blur) ? clamp(o.blur, 0, 40) : 0;
  const opacity =
    typeof o.opacity === 'number' && Number.isFinite(o.opacity)
      ? clamp(o.opacity, 0.05, 1)
      : DEFAULT_CHAT_BG.opacity;
  return { mode, solidColor, imageUrl, blur, opacity };
}

type ChatBgApi = {
  get: () => Promise<unknown>;
  set: (patch: unknown) => Promise<unknown>;
  reset: () => Promise<unknown>;
  pickImage: () => Promise<unknown>;
  onChanged: (cb: (s: unknown) => void) => () => void;
};

const api = (): ChatBgApi | null => {
  const w = window as unknown as { electronAPI?: { chatBg?: ChatBgApi } };
  return w.electronAPI?.chatBg ?? null;
};

let state: ChatBackgroundState = { ...DEFAULT_CHAT_BG };
const listeners = new Set<(s: ChatBackgroundState) => void>();

function emit(next: ChatBackgroundState): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn(next);
  window.dispatchEvent(
    new CustomEvent<ChatBackgroundState>('cd:chat-bg-changed', { detail: next }),
  );
}

export const getChatBackground = (): ChatBackgroundState => state;

export function subscribeChatBackground(fn: (s: ChatBackgroundState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 启动时调用一次：本地缓存 → 主进程 → 订阅变更 */
export function initChatBackground(): () => void {
  try {
    const cached = localStorage.getItem(KEY);
    if (cached) emit(sanitizeChatBg(JSON.parse(cached)));
  } catch {
    /* ignore */
  }
  const a = api();
  if (!a) return () => undefined;
  void a.get().then((v) => emit(sanitizeChatBg(v)));
  return a.onChanged((v) => emit(sanitizeChatBg(v)));
}

export async function setChatBackground(
  patch: Partial<ChatBackgroundState>,
): Promise<ChatBackgroundState> {
  const next = sanitizeChatBg({ ...state, ...patch });
  emit(next);
  const a = api();
  if (!a) return next;
  return sanitizeChatBg(await a.set(patch));
}

export async function resetChatBackground(): Promise<ChatBackgroundState> {
  const a = api();
  if (!a) {
    emit({ ...DEFAULT_CHAT_BG });
    return getChatBackground();
  }
  return sanitizeChatBg(await a.reset());
}

export async function pickChatBackgroundImage(): Promise<ChatBackgroundState> {
  const a = api();
  if (!a) return getChatBackground();
  return sanitizeChatBg(await a.pickImage());
}

/** 把状态写成可挂到 .chat-container 的 CSS 变量 */
export function chatBgStyle(s: ChatBackgroundState): CSSProperties {
  if (s.mode === 'default') {
    return {
      ['--cd-chat-bg-image' as string]: 'none',
      ['--cd-chat-bg-color' as string]: 'transparent',
      ['--cd-chat-bg-blur' as string]: '0px',
      ['--cd-chat-bg-opacity' as string]: '0',
    };
  }
  const image =
    s.mode === 'image' && s.imageUrl ? `url("${s.imageUrl.replace(/"/g, '\\"')}")` : 'none';
  const color = s.mode === 'solid' ? s.solidColor : 'transparent';
  return {
    ['--cd-chat-bg-image' as string]: image,
    ['--cd-chat-bg-color' as string]: color,
    ['--cd-chat-bg-blur' as string]: `${s.blur}px`,
    ['--cd-chat-bg-opacity' as string]: String(s.opacity),
  };
}
