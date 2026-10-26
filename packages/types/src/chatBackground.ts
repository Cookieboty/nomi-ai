/** 图片主题背景：主进程与渲染进程共用的状态、默认值与校验。开关只看主题 pref === 'image'。 */
export interface ChatBackgroundState {
  /** chat-asset://images/panel-bg.<uuid>.<ext> 或内置预设 URL */
  imageUrl: string | null;
  /** 背景图模糊 px，0–40 */
  blur: number;
  /** 背景图不透明度 0.05–1 */
  opacity: number;
}

export const CHAT_BG_PRESET_URL = 'chat-asset://presets/background.jpg';
export const CHAT_BG_IMAGE_URL_PREFIX = 'chat-asset://images/';
/** 用户图片大小上限（字节） */
export const CHAT_BG_MAX_BYTES = 15 * 1024 * 1024;
/** 用户图片落盘前的最长边（px） */
export const CHAT_BG_MAX_EDGE = 2560;
/** 导入失败的错误码（放在错误消息开头，跨 IPC 后渲染端据此给出本地化提示） */
export const CHAT_BG_ERROR = {
  tooLarge: 'CHAT_BG_TOO_LARGE',
  unsupported: 'CHAT_BG_UNSUPPORTED',
} as const;

export const DEFAULT_CHAT_BG: ChatBackgroundState = {
  imageUrl: null,
  blur: 8,
  opacity: 0.4,
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function sanitizeChatBg(raw: unknown): ChatBackgroundState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof ChatBackgroundState, unknown>
  >;
  const imageUrl =
    typeof o.imageUrl === 'string' &&
    (o.imageUrl.startsWith(CHAT_BG_IMAGE_URL_PREFIX) || o.imageUrl === CHAT_BG_PRESET_URL)
      ? o.imageUrl
      : null;
  return {
    imageUrl,
    blur: num(o.blur) ? clamp(o.blur, 0, 40) : DEFAULT_CHAT_BG.blur,
    opacity: num(o.opacity) ? clamp(o.opacity, 0.05, 1) : DEFAULT_CHAT_BG.opacity,
  };
}
