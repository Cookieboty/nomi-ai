/**
 * 屏幕记忆的纯逻辑：设置校验、隐私排除匹配、相似帧判定、保留期清理。
 * 默认关闭；只在本机保存 OCR 文本与小缩略图。
 */

export interface ScreenMemSettings {
  enabled: boolean;
  /** 采样间隔（秒） */
  intervalSec: number;
  /** 保留天数 */
  retentionDays: number;
  /** 窗口标题 / 应用名包含这些词时整帧跳过（不区分大小写） */
  exclusions: string[];
  /** 暂停到某个时间点（ms）；0 = 未暂停 */
  pausedUntil: number;
  /** 截图提问的全局快捷键是否启用（Ctrl/⌘+Alt+A） */
  snipHotkey: boolean;
}

/** 按窗口标题子串匹配，中英文词都要保留，不随界面语言翻译 */
export const DEFAULT_EXCLUSIONS = [
  '1Password',
  'Bitwarden',
  'KeePass',
  'LastPass',
  '密码', // i18n-ignore
  'Password',
  '无痕', // i18n-ignore
  'InPrivate',
  'Incognito',
  '隐私浏览', // i18n-ignore
  '银行', // i18n-ignore
  'Bank',
];

export const DEFAULT_SCREEN_SETTINGS: ScreenMemSettings = {
  enabled: false,
  intervalSec: 60,
  retentionDays: 7,
  exclusions: DEFAULT_EXCLUSIONS,
  pausedUntil: 0,
  snipHotkey: true,
};

const INTERVALS = [30, 60, 120, 300, 600];
const RETENTIONS = [1, 3, 7, 14, 30];

export function sanitizeScreenSettings(raw: unknown): ScreenMemSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ScreenMemSettings>;
  const d = DEFAULT_SCREEN_SETTINGS;
  const ex = Array.isArray(r.exclusions)
    ? [...new Set(r.exclusions.map((s) => String(s).trim()).filter(Boolean))].slice(0, 100)
    : d.exclusions;
  return {
    enabled: r.enabled === true,
    intervalSec: INTERVALS.includes(Number(r.intervalSec)) ? Number(r.intervalSec) : d.intervalSec,
    retentionDays: RETENTIONS.includes(Number(r.retentionDays))
      ? Number(r.retentionDays)
      : d.retentionDays,
    exclusions: ex,
    pausedUntil: Number.isFinite(r.pausedUntil) ? Math.max(0, Number(r.pausedUntil)) : 0,
    snipHotkey: r.snipHotkey !== false,
  };
}

/** 任一可见窗口命中排除词则返回该词（整帧跳过），否则 null */
export function matchExclusion(windowNames: string[], exclusions: string[]): string | null {
  const ex = exclusions.map((e) => e.toLowerCase()).filter(Boolean);
  for (const n of windowNames) {
    const low = n.toLowerCase();
    const hit = ex.find((e) => low.includes(e));
    if (hit) return exclusions.find((e) => e.toLowerCase() === hit) ?? hit;
  }
  return null;
}

/** 两个灰度小图（同长度）的平均差 < 阈值视为“画面没变” */
export function similarFrame(a: Uint8Array | null, b: Uint8Array, threshold = 4): boolean {
  if (!a || a.length !== b.length || !b.length) return false;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length < threshold;
}

/** BGRA 位图 → 灰度数组（nativeImage.toBitmap 输出） */
export function toGray(bgra: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.floor(bgra.length / 4));
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = (bgra[p] * 0.114 + bgra[p + 1] * 0.587 + bgra[p + 2] * 0.299) | 0;
  }
  return out;
}

export function expired<T extends { at: number }>(items: T[], retentionDays: number, now: number) {
  const cutoff = now - retentionDays * 86_400_000;
  return items.filter((i) => i.at < cutoff);
}

/** 清理 OCR 文本：去多余空白，截断 */
export function cleanOcr(text: string, max = 4000): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, max);
}

/** 区域选框（显示坐标）→ 图像像素坐标，并裁到图片范围内 */
export function toImageRect(
  sel: { x: number; y: number; width: number; height: number },
  view: { width: number; height: number },
  img: { width: number; height: number },
) {
  const sx = img.width / view.width;
  const sy = img.height / view.height;
  const x = Math.max(0, Math.round(sel.x * sx));
  const y = Math.max(0, Math.round(sel.y * sy));
  const width = Math.min(img.width - x, Math.round(sel.width * sx));
  const height = Math.min(img.height - y, Math.round(sel.height * sy));
  return { x, y, width: Math.max(1, width), height: Math.max(1, height) };
}
