/** 全局界面背景：恢复已选图片与参数，用户图片优先于预设。 */
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
  solidColor: '#fff8f1',
  imageUrl: null,
  blur: 8,
  opacity: 0.4,
};
export const CHAT_BG_PRESET_URL = 'chat-asset://presets/background.jpg';

const KEY = 'cd.chatBackground';
const MODES: ChatBgMode[] = ['default', 'solid', 'image'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function sanitizeChatBg(raw: unknown): ChatBackgroundState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<ChatBackgroundState> & {
    blurLeft?: unknown;
    blurCenter?: unknown;
    blurRight?: unknown;
  };
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
  const px = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 40) : fallback;
  const blur = px(o.blur, px(o.blurCenter, px(o.blurLeft, px(o.blurRight, DEFAULT_CHAT_BG.blur))));
  const opacity =
    typeof o.opacity === 'number' && Number.isFinite(o.opacity)
      ? clamp(o.opacity, 0.05, 1)
      : DEFAULT_CHAT_BG.opacity;
  return {
    mode,
    solidColor,
    imageUrl,
    blur,
    opacity,
  };
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
let pendingWrites = 0;
let pendingPatch: Partial<ChatBackgroundState> = {};
let revision = 0;

function emit(next: ChatBackgroundState): void {
  state = next;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ...next,
        imageUrl: next.imageUrl?.startsWith('blob:') ? null : next.imageUrl,
      }),
    );
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

/** 启动时调用一次：缓存预览 → 主进程验证图片与预设 → 订阅变更 */
export function initChatBackground(): () => void {
  const initialRevision = revision;
  try {
    const cached = localStorage.getItem(KEY);
    if (cached) {
      emit(sanitizeChatBg(JSON.parse(cached)));
    }
  } catch {
    /* ignore */
  }
  const a = api();
  if (!a) return () => undefined;
  void a.get().then((value) => {
    if (revision === initialRevision) emit(sanitizeChatBg(value));
  });
  return a.onChanged((value) => {
    revision += 1;
    emit(sanitizeChatBg({ ...(value as object), ...pendingPatch }));
  });
}

export async function setChatBackground(
  patch: Partial<ChatBackgroundState>,
): Promise<ChatBackgroundState> {
  revision += 1;
  const next = sanitizeChatBg({ ...state, ...patch });
  emit(next);
  const a = api();
  if (!a) return next;
  pendingWrites += 1;
  pendingPatch = { ...pendingPatch, ...patch };
  try {
    await a.set(patch);
    return getChatBackground();
  } finally {
    pendingWrites -= 1;
    if (pendingWrites === 0) pendingPatch = {};
  }
}

export async function resetChatBackground(): Promise<ChatBackgroundState> {
  revision += 1;
  const a = api();
  if (!a) {
    emit({ ...DEFAULT_CHAT_BG });
    return getChatBackground();
  }
  const next = sanitizeChatBg(await a.reset());
  emit(next);
  return next;
}

export async function pickChatBackgroundImage(): Promise<ChatBackgroundState> {
  revision += 1;
  const a = api();
  if (!a) return getChatBackground();
  const next = sanitizeChatBg(await a.pickImage());
  emit(next);
  return next;
}

/** 背景层本身的 CSS 变量。 */
export function chatBgStyle(s: ChatBackgroundState): CSSProperties {
  if (s.mode === 'default') {
    return {
      ['--cd-chat-bg-image' as string]: 'none',
      ['--cd-chat-bg-color' as string]: 'transparent',
      ['--cd-chat-bg-opacity' as string]: '0',
    };
  }
  const image =
    s.mode === 'image' && s.imageUrl ? `url("${s.imageUrl.replace(/"/g, '\\"')}")` : 'none';
  const color = s.mode === 'solid' ? s.solidColor : 'transparent';
  return {
    ['--cd-chat-bg-image' as string]: image,
    ['--cd-chat-bg-color' as string]: color,
    ['--cd-chat-bg-opacity' as string]: String(s.opacity),
  };
}
