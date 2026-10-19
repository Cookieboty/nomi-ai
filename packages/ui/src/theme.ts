/**
 * 主题：用户选择（ThemePref，含「跟随系统」）→ 实际主题（ThemeId）写到 <html data-theme>。
 * Cool Mist 为 :root 基础令牌（不设属性），其余主题以 data-theme 覆盖。
 * 桌面端由主进程 `ai:theme:*` 持久化、解析「跟随系统」（nativeTheme）并广播给所有窗口；
 * 无 IPC 时退回 localStorage + prefers-color-scheme。
 *
 * 历史 id `paper`（纸白）在读写时映射为 `cream`（奶油），与品牌奶油色板对齐。
 */
export type ThemeId = 'mist' | 'graphite' | 'ink' | 'cream' | 'sunset';
export type ThemePref = ThemeId | 'system';

export interface ThemeInfo {
  id: ThemePref;
  name: string;
  desc: string;
  /** 预览色：背景 / 表面 / 文字 / 强调 */
  swatch: [string, string, string, string];
}

export const THEMES: ThemeInfo[] = [
  {
    id: 'sunset',
    name: 'Sunset Orange 日落橙（默认）',
    desc: '暖杏浅底 + Nomi 品牌橙',
    swatch: ['#fff6ec', '#ffefe3', '#3d2918', '#fb9466'],
  },
  {
    id: 'ink',
    name: 'Warm Ink 暖墨',
    desc: '暖中性暗色 + Nomi 品牌橙',
    swatch: ['#1a1917', '#272522', '#ece8e1', '#fb9466'],
  },
  {
    id: 'graphite',
    name: 'Graphite 石墨',
    desc: '中性暗色 + 低饱和靛蓝',
    swatch: ['#0f0f11', '#1b1b1e', '#ededef', '#6872e5'],
  },
  {
    id: 'cream',
    name: 'Cream 奶油',
    desc: '品牌奶油浅色 + 暖棕与橙',
    swatch: ['#fcefe1', '#fff9f3', '#33291f', '#fb9466'],
  },
  {
    id: 'mist',
    name: 'Cool Mist 冷雾',
    desc: '冷灰蓝底 + 青蓝强调',
    swatch: ['#0a0f1a', '#1e293b', '#e8eef7', '#3898c4'],
  },
  {
    id: 'system',
    name: '跟随系统',
    desc: '深色 → 石墨 · 浅色 → 奶油',
    swatch: ['#0f0f11', '#1b1b1e', '#fcefe1', '#fb9466'],
  },
];

/** 新用户默认；已保存的选择优先 */
export const DEFAULT_THEME: ThemePref = 'sunset';
const KEY = 'cd.theme';
const THEME_IDS: ThemeId[] = ['mist', 'graphite', 'ink', 'cream', 'sunset'];
/** 旧版 Light Paper / 纸白 */
const LEGACY_THEME: Record<string, ThemeId> = { paper: 'cream' };

export const isThemeId = (v: unknown): v is ThemeId => THEME_IDS.includes(v as ThemeId);
export const isThemePref = (v: unknown): v is ThemePref =>
  v === 'system' || isThemeId(v) || v === 'paper';

/** 规范主题 id（paper → cream） */
export const normalizeThemePref = (v: unknown): ThemePref | null => {
  if (typeof v !== 'string') return null;
  if (v === 'system') return 'system';
  if (v in LEGACY_THEME) return LEGACY_THEME[v]!;
  return isThemeId(v) ? v : null;
};

/** 跟随系统：深色 → Graphite，浅色 → Cream */
export const resolveTheme = (pref: ThemePref, dark: boolean): ThemeId =>
  pref === 'system' ? (dark ? 'graphite' : 'cream') : pref;

export interface ThemeState {
  pref: ThemePref;
  resolved: ThemeId;
}

interface Bridge {
  invoke(ch: string, ...a: unknown[]): Promise<unknown>;
  on(ch: string, fn: (p: unknown) => void): () => void;
}
const bridge = (): Bridge | undefined => {
  const b = (globalThis as { aiIPC?: Bridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
};
const systemDark = () =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : true;

let state: ThemeState = { pref: DEFAULT_THEME, resolved: resolveTheme(DEFAULT_THEME, true) };

function apply(next: ThemeState): void {
  state = next;
  const el = document.documentElement;
  if (next.resolved === 'mist') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', next.resolved);
  el.setAttribute('data-theme-pref', next.pref);
  try {
    localStorage.setItem(KEY, next.pref);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent<ThemeState>('cd:theme-changed', { detail: next }));
}

/** 直接应用某个主题选择（无 IPC 时用浏览器的配色偏好解析「跟随系统」） */
export function applyTheme(pref: ThemePref): void {
  const n = normalizeThemePref(pref) ?? DEFAULT_THEME;
  apply({ pref: n, resolved: resolveTheme(n, systemDark()) });
}

export const currentTheme = (): ThemeState => state;

const fromPayload = (v: unknown): ThemeState | null => {
  const o = v as Partial<ThemeState> | null;
  if (o && typeof o === 'object' && 'pref' in o) {
    const pref = normalizeThemePref(o.pref);
    const resolved = normalizeThemePref(o.resolved);
    if (pref && resolved && isThemeId(resolved)) return { pref, resolved };
  }
  const pref = normalizeThemePref(v);
  if (pref) return { pref, resolved: resolveTheme(pref, systemDark()) };
  return null;
};

/** 启动时调用一次：先用本地缓存避免闪烁，再以主进程为准并订阅变更 */
export function initTheme(): () => void {
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  applyTheme(normalizeThemePref(cached) ?? DEFAULT_THEME);
  const b = bridge();
  if (!b) {
    // 浏览器 / 测试：跟随 prefers-color-scheme 实时变化
    if (typeof matchMedia !== 'function') return () => undefined;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => state.pref === 'system' && applyTheme('system');
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }
  void b
    .invoke('ai:theme:get')
    .then((v) => {
      const s = fromPayload(v);
      if (s) apply(s);
    })
    .catch(() => undefined);
  return b.on('ai:theme:changed', (v) => {
    const s = fromPayload(v);
    if (s) apply(s);
  });
}

/** 用户在设置里选择主题 */
export async function setTheme(pref: ThemePref): Promise<void> {
  applyTheme(pref);
  const b = bridge();
  if (!b) return;
  const s = fromPayload(await b.invoke('ai:theme:set', pref).catch(() => null));
  if (s) apply(s);
}
