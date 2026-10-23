/**
 * 工作台背景（侧栏 / 对话列 / Diff 与文件栏）：主进程 chat-bg:* 持久化；无 IPC 时落 localStorage（浏览器 / 单测）。
 */
import type { CSSProperties } from 'react';

export type ChatBgMode = 'default' | 'solid' | 'image';

export interface ChatBackgroundState {
  mode: ChatBgMode;
  solidColor: string;
  imageUrl: string | null;
  /** 各栏透出背景时的模糊 px：左 = 侧栏，中 = 对话列，右 = Diff 与文件栏 */
  blurLeft: number;
  blurCenter: number;
  blurRight: number;
  opacity: number;
}

export const DEFAULT_CHAT_BG: ChatBackgroundState = {
  mode: 'default',
  solidColor: '#fff8f1',
  imageUrl: null,
  blurLeft: 0,
  blurCenter: 0,
  blurRight: 0,
  opacity: 0.35,
};

const KEY = 'cd.chatBackground';
const MODES: ChatBgMode[] = ['default', 'solid', 'image'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function sanitizeChatBg(raw: unknown): ChatBackgroundState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<ChatBackgroundState> & {
    /** 旧版单一 blur：没有分栏值时三栏都沿用 */
    blur?: unknown;
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
  const legacy = px(o.blur, 0);
  const opacity =
    typeof o.opacity === 'number' && Number.isFinite(o.opacity)
      ? clamp(o.opacity, 0.05, 1)
      : DEFAULT_CHAT_BG.opacity;
  return {
    mode,
    solidColor,
    imageUrl,
    blurLeft: px(o.blurLeft, legacy),
    blurCenter: px(o.blurCenter, legacy),
    blurRight: px(o.blurRight, legacy),
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

/** 背景层本身的 CSS 变量（图片 / 纯色 / 透明度）；三栏模糊见 chatBgBlurVars */
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

/** 三栏各自的 backdrop 模糊：挂到 <html> 上，侧栏 / 对话列 / 右侧各栏都能读到 */
export function chatBgBlurVars(s: ChatBackgroundState): Record<string, string> {
  return {
    '--cd-chat-bg-blur-left': `${s.blurLeft}px`,
    '--cd-chat-bg-blur-center': `${s.blurCenter}px`,
    '--cd-chat-bg-blur-right': `${s.blurRight}px`,
  };
}
