/**
 * 图片主题背景（图片 / 模糊 / 透明度）：主进程（契约 chatBg.*）持久化；无传输时落 localStorage（浏览器 / 单测）。
 * 是否显示只看主题 pref === 'image'；状态与校验共用 @nomi-ai/types。
 */
import {
  CHAT_BG_ERROR,
  CHAT_BG_MAX_BYTES,
  CHAT_BG_PRESET_URL,
  DEFAULT_CHAT_BG,
  sanitizeChatBg,
  type ChatBackgroundState,
} from '@nomi-ai/types';
import { createLogger, t as tr } from '@nomi-ai/ui';
import type { CSSProperties } from 'react';

import { api, hasTransport } from './api';

export { CHAT_BG_PRESET_URL, DEFAULT_CHAT_BG, sanitizeChatBg, type ChatBackgroundState };

const KEY = 'cd.chatBackground';
const log = createLogger('chat-bg');
/** 滑块拖动时合并写入主进程的间隔 */
export const CHAT_BG_WRITE_DEBOUNCE_MS = 150;

type ChatBgApi = {
  get: () => Promise<unknown>;
  set: (patch: Partial<ChatBackgroundState>) => Promise<unknown>;
  reset: () => Promise<unknown>;
  pickImage: () => Promise<unknown>;
  onChanged: (cb: (s: unknown) => void) => () => void;
};

/** 主进程（契约 chatBg.*）；没有传输（浏览器预览 / 单测）时为 null，走本地状态 */
const backend = (): ChatBgApi | null =>
  hasTransport()
    ? {
        get: () => api.chatBg.get(),
        set: (patch) => api.chatBg.set(patch),
        reset: () => api.chatBg.reset(),
        pickImage: () => api.chatBg.pickImage(),
        onChanged: (cb) => api.on('chatBg.changed', cb),
      }
    : null;

let state: ChatBackgroundState = { ...DEFAULT_CHAT_BG };
const listeners = new Set<(s: ChatBackgroundState) => void>();
/** 尚未发出的补丁（防抖中）与已发出未返回的补丁：主进程广播回来时叠加，避免滑块回跳 */
let queuedPatch: Partial<ChatBackgroundState> = {};
let inFlightPatch: Partial<ChatBackgroundState> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let waiters: Array<(s: ChatBackgroundState) => void> = [];
let revision = 0;

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

/** 启动时调用一次：缓存预览 → 主进程验证图片与预设 → 订阅变更 */
export function initChatBackground(): () => void {
  const initialRevision = revision;
  try {
    const cached = localStorage.getItem(KEY);
    if (cached) emit(sanitizeChatBg(JSON.parse(cached)));
  } catch {
    /* ignore */
  }
  const a = backend();
  if (!a) return () => undefined;
  void a.get().then((value) => {
    if (revision === initialRevision) emit(sanitizeChatBg(value));
  });
  return a.onChanged((value) => {
    revision += 1;
    emit(sanitizeChatBg({ ...(value as object), ...inFlightPatch, ...queuedPatch }));
  });
}

async function flush(): Promise<void> {
  flushTimer = null;
  const a = backend();
  const patch = queuedPatch;
  const done = waiters;
  queuedPatch = {};
  waiters = [];
  inFlightPatch = { ...inFlightPatch, ...patch };
  try {
    if (a) await a.set(patch);
  } catch (error) {
    // 主进程没写进去：拉回主进程的真实值（叠加还没发出的补丁），界面不显示一个没保存的值
    log.warn('chat-bg:set failed, resyncing', error);
    try {
      if (a) {
        revision += 1;
        emit(sanitizeChatBg({ ...((await a.get()) as object), ...queuedPatch }));
      }
    } catch {
      /* 读也失败：保留本地预览 */
    }
  } finally {
    if (!flushTimer) inFlightPatch = {};
    for (const fn of done) fn(getChatBackground());
  }
}

/** 本地立即生效；写主进程按 CHAT_BG_WRITE_DEBOUNCE_MS 合并（拖动滑块只落一次盘）。 */
export function setChatBackground(
  patch: Partial<ChatBackgroundState>,
): Promise<ChatBackgroundState> {
  revision += 1;
  const next = sanitizeChatBg({ ...state, ...patch });
  emit(next);
  if (!backend()) return Promise.resolve(next);
  queuedPatch = { ...queuedPatch, ...patch };
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(), CHAT_BG_WRITE_DEBOUNCE_MS);
  return new Promise((resolve) => waiters.push(resolve));
}

/** 当前图片加载失败（文件被删 / 移走）：让主进程重新校验并回退预设；无 IPC 时直接回退预设。 */
export async function revalidateChatBackground(): Promise<ChatBackgroundState> {
  revision += 1;
  const a = backend();
  if (!a) {
    const next = {
      ...state,
      imageUrl: state.imageUrl === CHAT_BG_PRESET_URL ? null : CHAT_BG_PRESET_URL,
    };
    emit(next);
    return next;
  }
  const next = sanitizeChatBg(await a.set({}));
  emit(next);
  return next;
}

export async function resetChatBackground(): Promise<ChatBackgroundState> {
  revision += 1;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  queuedPatch = {};
  const pending = waiters;
  waiters = [];
  const a = backend();
  if (!a) {
    emit({ ...DEFAULT_CHAT_BG });
    for (const fn of pending) fn(getChatBackground());
    return getChatBackground();
  }
  const next = sanitizeChatBg(await a.reset());
  emit(next);
  for (const fn of pending) fn(next);
  return next;
}

export async function pickChatBackgroundImage(): Promise<ChatBackgroundState> {
  revision += 1;
  const a = backend();
  if (!a) return getChatBackground();
  const next = sanitizeChatBg(await a.pickImage());
  emit(next);
  return next;
}

/** 选图失败的本地化提示：主进程错误跨 IPC 后只剩消息文本，按开头的错误码识别 */
export function chatBgErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes(CHAT_BG_ERROR.tooLarge)) {
    return tr(
      'ui.chat-settings.background-image-too-large',
      String(CHAT_BG_MAX_BYTES / 1024 / 1024),
    );
  }
  if (msg.includes(CHAT_BG_ERROR.unsupported)) {
    return tr('ui.chat-settings.background-image-unsupported');
  }
  return tr('ui.chat-settings.background-image-import-failed');
}

/** 背景层本身的 CSS 变量（图片 / 透明度）；模糊变量由背景层写到 <html>。 */
export function chatBgStyle(s: ChatBackgroundState): CSSProperties {
  return {
    ['--cd-chat-bg-image' as string]: s.imageUrl
      ? `url("${s.imageUrl.replace(/"/g, '\\"')}")`
      : 'none',
    ['--cd-chat-bg-opacity' as string]: String(s.opacity),
  };
}
