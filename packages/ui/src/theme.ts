/**
 * 主题：用户选择（ThemePref，含「跟随系统」）→ 实际主题（ThemeId）写到 <html data-theme>。
 * :root 为日落橙（默认）令牌，每个主题都写 data-theme（含 sunset）。
 * 桌面端由主进程 `ai:theme:*` 持久化、解析「跟随系统」（nativeTheme）并广播给所有窗口；
 * 无 IPC 时退回 localStorage + prefers-color-scheme。
 *
 * 历史 id `paper`（纸白）读入时映射为 `cream`（奶油）。
 */
export type ThemeId = 'mist' | 'graphite' | 'ink' | 'cream' | 'sunset';
export type ThemePref = ThemeId | 'system' | 'image';

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
    name: 'ui.mascot-theme.sunset-orange-brand',
    desc: 'ui.mascot-theme.warm-cream-with-sunset-orange-the-signature-theme',
    swatch: ['#fff8f1', '#ffffff', '#3f332d', '#c45425'],
  },
  {
    id: 'ink',
    name: 'ui.mascot-theme.warm-ink',
    desc: 'ui.mascot-theme.deep-coffee-with-sunset-orange-a-warm-dark',
    swatch: ['#201a17', '#302722', '#f5ede6', '#f08a5d'],
  },
  {
    id: 'graphite',
    name: 'ui.mascot-theme.graphite',
    desc: 'ui.mascot-theme.neutral-charcoal-with-indigo-a-technical-dark-theme',
    swatch: ['#13161b', '#20252d', '#f0f2f6', '#7887f5'],
  },
  {
    id: 'cream',
    name: 'ui.mascot-theme.cream',
    desc: 'ui.mascot-theme.cream-white-with-soft-peach-the-lightest-theme',
    swatch: ['#fffcf6', '#ffffff', '#403126', '#ab653e'],
  },
  {
    id: 'mist',
    name: 'ui.mascot-theme.cool-mist',
    desc: 'ui.mascot-theme.cool-grey-with-mist-blue-clear-and-calm',
    swatch: ['#f5f8f9', '#ffffff', '#20343d', '#4f7182'],
  },
  {
    id: 'system',
    name: 'ui.mascot-theme.follow-system',
    desc: 'ui.mascot-theme.dark-graphite-light-cream',
    swatch: ['#13161b', '#20252d', '#fffcf6', '#7887f5'],
  },
  {
    id: 'image',
    name: 'ui.chat-settings.image-theme',
    desc: 'ui.chat-settings.covers-all-interfaces',
    swatch: ['#13161b', '#20252d', '#f0f2f6', '#7887f5'],
  },
];

/** 新用户默认；已保存的选择优先 */
export const DEFAULT_THEME: ThemePref = 'sunset';
const KEY = 'cd.theme';
const THEME_IDS: ThemeId[] = ['mist', 'graphite', 'ink', 'cream', 'sunset'];
/** 旧版 Light Paper / 纸白（v1.0.4 起改名奶油），本地缓存里可能还留着 */
const LEGACY_THEME: Record<string, ThemeId> = { paper: 'cream' };

export const isThemeId = (v: unknown): v is ThemeId => THEME_IDS.includes(v as ThemeId);
export const isThemePref = (v: unknown): v is ThemePref =>
  v === 'system' || v === 'image' || isThemeId(v);

/** 规范主题 id（旧 id paper → cream）；未知值返回 null */
export const normalizeThemePref = (v: unknown): ThemePref | null => {
  if (typeof v !== 'string') return null;
  if (v === 'system' || v === 'image') return v;
  if (v in LEGACY_THEME) return LEGACY_THEME[v]!;
  return isThemeId(v) ? v : null;
};

/** 跟随系统：深色 → Graphite，浅色 → Cream */
export const resolveTheme = (pref: ThemePref, dark: boolean): ThemeId =>
  pref === 'image' ? 'graphite' : pref === 'system' ? (dark ? 'graphite' : 'cream') : pref;

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
  el.setAttribute('data-theme', next.resolved);
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
