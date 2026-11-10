/**
 * 主题：用户选择（ThemePref，含「跟随系统」）→ 实际主题（ThemeId）写到 <html data-theme>。
 * :root 为浅色（默认）令牌，每个主题都写 data-theme（含 light）。
 * 浅色 / 深色参考 WorkBuddy 的中性灰阶，强调色仍是日落橙；「跟随系统」在这两套之间切换。
 * 桌面端由主进程（主题服务）持久化、解析「跟随系统」并广播给所有窗口：视图入口经 `setThemeBackend`
 * 接上（应用契约 `theme.*`，本包不依赖契约）；没有后端时退回 localStorage + prefers-color-scheme。
 *
 * 历史 id `paper`（纸白）读入时映射为 `cream`（奶油）。
 */
import {
  CUSTOM_PREF_PREFIX,
  customThemeCss,
  isAdaptiveTheme,
  isCustomThemeId,
  parseCustomTheme,
  resolveCustomBase,
  type CustomThemeDef,
  type ThemeBase,
} from './customTheme';

export type ThemeId = 'light' | 'dark' | 'mist' | 'graphite' | 'ink' | 'cream' | 'sunset';
/** 自定义主题：`custom:<id>`，定义由主进程（Go 内核）存储并随主题状态一起广播 */
export type CustomThemePref = `custom:${string}`;
export type ThemePref = ThemeId | 'system' | 'image' | CustomThemePref;

export interface ThemeInfo {
  id: ThemePref;
  name: string;
  desc: string;
  /** 预览色：背景 / 表面 / 文字 / 强调 */
  swatch: [string, string, string, string];
}

export const THEMES: ThemeInfo[] = [
  {
    id: 'light',
    name: 'ui.mascot-theme.theme-light',
    desc: 'ui.mascot-theme.theme-light-desc',
    swatch: ['#f7f7f7', '#ffffff', '#141414', '#c45425'],
  },
  {
    id: 'dark',
    name: 'ui.mascot-theme.theme-dark',
    desc: 'ui.mascot-theme.theme-dark-desc',
    swatch: ['#141414', '#1f1f1f', '#f2f2f2', '#f08a5d'],
  },
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
    desc: 'ui.mascot-theme.follow-system-light-dark',
    swatch: ['#141414', '#1f1f1f', '#f7f7f7', '#f08a5d'],
  },
  {
    id: 'image',
    name: 'ui.chat-settings.image-theme',
    desc: 'ui.chat-settings.covers-all-interfaces',
    swatch: ['#13161b', '#20252d', '#f0f2f6', '#7887f5'],
  },
];

/** 新用户默认；已保存的选择优先 */
export const DEFAULT_THEME: ThemePref = 'light';
const KEY = 'cd.theme';
/** 当前自定义主题的定义缓存（启动时先注入，避免闪一下基底主题） */
const CUSTOM_KEY = 'cd.theme.custom';
const STYLE_ID = 'cd-custom-theme';
const THEME_IDS: ThemeId[] = ['light', 'dark', 'mist', 'graphite', 'ink', 'cream', 'sunset'];
/** 旧版 Light Paper / 纸白（v1.0.4 起改名奶油），本地缓存里可能还留着 */
const LEGACY_THEME: Record<string, ThemeId> = { paper: 'cream' };

export const isThemeId = (v: unknown): v is ThemeId => THEME_IDS.includes(v as ThemeId);
export const isCustomThemePref = (v: unknown): v is CustomThemePref =>
  typeof v === 'string' &&
  v.startsWith(CUSTOM_PREF_PREFIX) &&
  isCustomThemeId(v.slice(CUSTOM_PREF_PREFIX.length));
export const customThemePref = (id: string): CustomThemePref => `custom:${id}`;
export const isThemePref = (v: unknown): v is ThemePref =>
  v === 'system' || v === 'image' || isThemeId(v) || isCustomThemePref(v);

/** 规范主题 id（旧 id paper → cream）；未知值返回 null */
export const normalizeThemePref = (v: unknown): ThemePref | null => {
  if (typeof v !== 'string') return null;
  if (v === 'system' || v === 'image' || isCustomThemePref(v)) return v;
  if (v in LEGACY_THEME) return LEGACY_THEME[v]!;
  return isThemeId(v) ? v : null;
};

/** 跟随系统：深色 → Dark，浅色 → Light；自定义主题解析为它的基底（带两套明暗的按系统） */
export const resolveTheme = (
  pref: ThemePref,
  dark: boolean,
  custom?: CustomThemeDef | null,
): ThemeId =>
  pref === 'image'
    ? 'graphite'
    : pref === 'system'
      ? dark
        ? 'dark'
        : 'light'
      : isCustomThemePref(pref)
        ? custom
          ? resolveCustomBase(custom, dark)
          : 'light'
        : pref;

export interface ThemeState {
  pref: ThemePref;
  resolved: ThemeId;
  /** pref 是自定义主题时的定义 */
  custom?: CustomThemeDef | null;
}

/** 主进程主题服务的注入点（视图入口在 initTheme 之前接上；返回值形状同 ThemeState） */
export interface ThemeBackend {
  get(): Promise<unknown>;
  set(pref: ThemePref): Promise<unknown>;
  /** 订阅主题变化；返回取消订阅 */
  onChanged(fn: (state: unknown) => void): () => void;
}

let backend: ThemeBackend | null = null;

/** 接上 / 拿掉主进程主题服务（null = 只用本地状态） */
export function setThemeBackend(b: ThemeBackend | null): void {
  backend = b;
}
const systemDark = () =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : true;

let state: ThemeState = { pref: DEFAULT_THEME, resolved: resolveTheme(DEFAULT_THEME, true) };

/** 预览中的自定义主题与要看的那套明暗（设置里编辑时实时套用，不改已保存的选择） */
let preview: { def: CustomThemeDef; base: ThemeBase } | null = null;

/** 把自定义主题某一套明暗的令牌写进 <style>，并设 data-theme-custom；null = 去掉 */
function paintCustom(el: HTMLElement, def: CustomThemeDef | null, base: ThemeBase): void {
  let tag = document.getElementById(STYLE_ID);
  if (!def) {
    tag?.remove();
    el.removeAttribute('data-theme-custom');
    return;
  }
  if (!tag) {
    tag = document.createElement('style');
    tag.id = STYLE_ID;
    document.head.appendChild(tag);
  }
  tag.textContent = customThemeCss(def, base);
  el.setAttribute('data-theme-custom', def.id);
}

function paint(): void {
  const el = document.documentElement;
  const resolved = preview ? preview.base : state.resolved;
  el.setAttribute('data-theme', resolved);
  el.setAttribute('data-theme-pref', state.pref);
  // 自定义主题的 resolved 一定是 light / dark（它的某一套明暗）
  paintCustom(el, preview?.def ?? state.custom ?? null, resolved === 'dark' ? 'dark' : 'light');
}

function apply(next: ThemeState): void {
  const custom = isCustomThemePref(next.pref) ? (next.custom ?? null) : null;
  state = custom
    ? { pref: next.pref, resolved: next.resolved, custom }
    : { pref: next.pref, resolved: next.resolved };
  paint();
  try {
    localStorage.setItem(KEY, next.pref);
    if (custom) localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
    else localStorage.removeItem(CUSTOM_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent<ThemeState>('cd:theme-changed', { detail: state }));
}

function cachedCustom(pref: ThemePref): CustomThemeDef | null {
  if (!isCustomThemePref(pref)) return null;
  if (state.custom && customThemePref(state.custom.id) === pref) return state.custom;
  try {
    const def = parseCustomTheme(JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? 'null'));
    return def && customThemePref(def.id) === pref ? def : null;
  } catch {
    return null;
  }
}

/** 直接应用某个主题选择（无 IPC 时用浏览器的配色偏好解析「跟随系统」） */
export function applyTheme(pref: ThemePref): void {
  const n = normalizeThemePref(pref) ?? DEFAULT_THEME;
  const custom = cachedCustom(n);
  // 自定义主题没有定义（缓存丢了）且没有后端：退回默认，不留一个空壳
  if (isCustomThemePref(n) && !custom && !backend) return applyTheme(DEFAULT_THEME);
  apply({ pref: n, resolved: resolveTheme(n, systemDark(), custom), custom });
}

/**
 * 编辑自定义主题时实时预览（只影响当前窗口，不保存）；base 选看哪套明暗（默认主套）；传 null 恢复已保存的主题。
 * 预览变化时发 `cd:theme-preview-changed`（背景图层据此跟着预览）。
 */
export function previewCustomTheme(def: CustomThemeDef | null, base?: ThemeBase): void {
  preview = def ? { def, base: base ?? def.base } : null;
  paint();
  window.dispatchEvent(new CustomEvent('cd:theme-preview-changed'));
}

export const currentTheme = (): ThemeState => state;

/** 当前窗口实际显示的自定义主题（预览优先）；不是自定义主题时为 null */
export const visibleCustomTheme = (): CustomThemeDef | null => preview?.def ?? state.custom ?? null;

const fromPayload = (v: unknown): ThemeState | null => {
  const o = v as Partial<ThemeState> | null;
  if (o && typeof o === 'object' && 'pref' in o) {
    const pref = normalizeThemePref(o.pref);
    const resolved = normalizeThemePref(o.resolved);
    if (pref && resolved && isThemeId(resolved))
      return { pref, resolved, custom: parseCustomTheme(o.custom) };
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
  const b = backend;
  if (!b) {
    // 浏览器 / 测试：跟随 prefers-color-scheme 实时变化
    if (typeof matchMedia !== 'function') return () => undefined;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () =>
      (state.pref === 'system' || (state.custom && isAdaptiveTheme(state.custom))) &&
      applyTheme(state.pref);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }
  void b
    .get()
    .then((v) => {
      const s = fromPayload(v);
      if (s) apply(s);
    })
    .catch(() => undefined);
  return b.onChanged((v) => {
    const s = fromPayload(v);
    if (s) apply(s);
  });
}

/** 用户在设置里选择主题 */
export async function setTheme(pref: ThemePref): Promise<void> {
  applyTheme(pref);
  const b = backend;
  if (!b) return;
  const s = fromPayload(await b.set(pref).catch(() => null));
  if (s) apply(s);
}
