/**
 * 自定义主题：用户填的几个种子色（或导入的主题包）→ 一整套令牌。
 *
 * 结构是「基底主题 + 推导 + 覆盖」：`data-theme` 设成基底（light / dark），所有令牌先有值；
 * 种子色推导出的令牌与主题包里的 `tokens` 覆盖写进 `:root[data-theme-custom]`。新加的令牌没被推导时从基底继承。
 *
 * 对比度沿用 tokens.css 的规则：accent 会承载文字，强调色上的文字不足 4.5:1 时把 accent 微调到达标，
 * 用户填的原色留在 --cd-color-brand（开关、强调线等不放文字的地方）。
 *
 * 一个主题可以同时带浅色和深色两套（variants 里放与 base 相反的那套）：带了就跟随系统切换。
 * 还可以带一张背景图（与图片主题同一套图层：清晰底图 + 蒙版模糊 / 不透明度）。
 *
 * 主题包的格式就是这里的 CustomThemeDef（去掉 id），Go 内核（internal/core/theme）负责导入校验与存储；
 * 这里的 parseCustomTheme 只在视图里再拦一次明显不对的值。
 */
import { isThemeableToken } from './themeTokens';

/** 2：加了 variants 与 background（只用到第 1 版字段的主题包仍按 1 导出） */
export const CUSTOM_THEME_FORMAT = 2;
export const SEED_KEYS = ['accent', 'background', 'surface', 'text'] as const;
export type SeedKey = (typeof SEED_KEYS)[number];
export type ThemeBase = 'light' | 'dark';

export interface CustomThemeDef {
  id: string;
  format: number;
  /** 按界面语言的名称（zh / en），至少一个 */
  name: Record<string, string>;
  author?: string;
  base: ThemeBase;
  seeds: Partial<Record<SeedKey, string>>;
  /** 进阶：直接覆盖的令牌（只认 THEMEABLE_TOKENS） */
  tokens?: Record<string, string>;
  /** 另一套明暗（键只能是与 base 相反的那个）：有就跟随系统在两套之间切换 */
  variants?: Partial<Record<ThemeBase, ThemeVariant>>;
  /** 背景图（chat-asset://themes/…，由内核存放）与蒙版 */
  background?: ThemeBackground;
}

export interface ThemeVariant {
  seeds: Partial<Record<SeedKey, string>>;
  tokens?: Record<string, string>;
}

export interface ThemeBackground {
  image: string;
  /** 蒙版的背景采样模糊（px，0–40） */
  blur: number;
  /** 蒙版不透明度（0.05–1） */
  opacity: number;
}

export const THEME_BG_PREFIX = 'chat-asset://themes/';
export const DEFAULT_THEME_BG = { blur: 0, opacity: 0.5 } as const;

export const otherBase = (b: ThemeBase): ThemeBase => (b === 'dark' ? 'light' : 'dark');

/** 一套明暗的视图：base + 种子 + 覆盖 */
export type ThemeVariantView = Pick<CustomThemeDef, 'base' | 'seeds' | 'tokens'>;

/** 带了另一套明暗：跟随系统 */
export const isAdaptiveTheme = (def: Pick<CustomThemeDef, 'base' | 'variants'>): boolean =>
  !!def.variants?.[otherBase(def.base)];

/** 取某一套明暗（没有那套就用主套） */
export function themeVariant(def: CustomThemeDef, base: ThemeBase = def.base): ThemeVariantView {
  const v = base !== def.base ? def.variants?.[base] : undefined;
  if (!v)
    return { base: def.base, seeds: def.seeds, ...(def.tokens ? { tokens: def.tokens } : {}) };
  return { base, seeds: v.seeds, ...(v.tokens ? { tokens: v.tokens } : {}) };
}

/** 自定义主题实际用哪套明暗：跟随系统的按系统，否则就是 base */
export const resolveCustomBase = (def: CustomThemeDef, systemDark: boolean): ThemeBase =>
  isAdaptiveTheme(def) ? (systemDark ? 'dark' : 'light') : def.base;

/** 基底主题的种子值（tokens.css 的 light / dark）：主题包缺的种子从这里补 */
export const BASE_SEEDS: Record<ThemeBase, Record<SeedKey, string>> = {
  light: { accent: '#c45425', background: '#f7f7f7', surface: '#ffffff', text: '#141414' },
  dark: { accent: '#f08a5d', background: '#141414', surface: '#1f1f1f', text: '#f2f2f2' },
};

export const CUSTOM_PREF_PREFIX = 'custom:';
const CUSTOM_ID = /^[a-z0-9]{1,32}$/;
export const isCustomThemeId = (v: unknown): v is string =>
  typeof v === 'string' && CUSTOM_ID.test(v);

// ---------------------------------------------------------------------------
// 颜色运算（sRGB ⇄ OKLab / OKLCH，WCAG 对比度）
// ---------------------------------------------------------------------------

type RGB = [number, number, number]; // 0–255
type Lab = [number, number, number];

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

export function parseHex(hex: string): RGB | null {
  if (!isHexColor(hex)) return null;
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function toHex([r, g, b]: RGB): string {
  return (
    '#' +
    [r, g, b]
      .map((v) =>
        Math.round(clamp(v, 0, 255))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) =>
  255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function rgbToLab(rgb: RGB): Lab {
  const [r, g, b] = rgb.map(toLinear) as RGB;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → 线性 sRGB（可能超出 0–1，调用方判断是否在色域内） */
function labToLinear([L, a, b]: Lab): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (lin: RGB) => lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH → sRGB：超出色域时降低彩度直到落进来（保持亮度与色相） */
function lchToRgb(L: number, C: number, H: number): RGB {
  let c = C;
  for (let i = 0; i < 24; i++) {
    const lin = labToLinear([L, c * Math.cos(H), c * Math.sin(H)]);
    if (inGamut(lin) || c < 1e-4) return lin.map((v) => fromLinear(clamp(v, 0, 1))) as RGB;
    c *= 0.85;
  }
  return labToLinear([L, 0, 0]).map((v) => fromLinear(clamp(v, 0, 1))) as RGB;
}

function toLch(hex: string): [number, number, number] {
  const [L, a, b] = rgbToLab(parseHex(hex) ?? [0, 0, 0]);
  return [L, Math.hypot(a, b), Math.atan2(b, a)];
}

/** 在 OKLCH 里改亮度（dL 为 OKLab 的 L，0–1） */
export function shiftLightness(hex: string, dL: number): string {
  const [L, C, H] = toLch(hex);
  return toHex(lchToRgb(clamp(L + dL, 0, 1), C, H));
}

/** 在 OKLab 里混色：t=0 → a，t=1 → b */
export function mixColor(a: string, b: string, t: number): string {
  const la = rgbToLab(parseHex(a) ?? [0, 0, 0]);
  const lb = rgbToLab(parseHex(b) ?? [0, 0, 0]);
  const lin = labToLinear([0, 1, 2].map((i) => la[i]! + (lb[i]! - la[i]!) * t) as Lab);
  return toHex(lin.map((v) => fromLinear(clamp(v, 0, 1))) as RGB);
}

export function luminance(hex: string): number {
  const [r, g, b] = (parseHex(hex) ?? [0, 0, 0]).map(toLinear) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 把 fg 的亮度往远离背景的方向推，直到与 bgs 里每个背景的对比度都 ≥ min；推到头仍不够就返回最接近的。
 */
export function ensureContrast(fg: string, bgs: string[], min: number): string {
  const ok = (c: string) => bgs.every((bg) => contrastRatio(c, bg) >= min);
  if (ok(fg)) return fg;
  const darker = bgs.reduce((s, bg) => s + luminance(bg), 0) / bgs.length > 0.18;
  let c = fg;
  for (let i = 0; i < 100 && !ok(c); i++) c = shiftLightness(c, darker ? -0.01 : 0.01);
  return c;
}

const rgbTriplet = (hex: string) => (parseHex(hex) ?? [0, 0, 0]).join(', ');
const rgba = (hex: string, a: number) => `rgba(${rgbTriplet(hex)}, ${a})`;

/** 按背景亮度建议基底：深背景配 dark（原生窗口外观、状态色都跟着走） */
export const suggestBase = (background: string): ThemeBase =>
  luminance(background) < 0.18 ? 'dark' : 'light';

/** 从一段文字里按出现顺序取出 hex 颜色（用户一次粘贴一批主题色） */
export function parsePalette(text: string): string[] {
  return (text.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi) ?? []).map((c) => toHex(parseHex(c)!));
}

// ---------------------------------------------------------------------------
// 推导
// ---------------------------------------------------------------------------

export function resolvedSeeds(
  def: Pick<CustomThemeDef, 'base' | 'seeds'>,
): Record<SeedKey, string> {
  const base = BASE_SEEDS[def.base];
  const out = { ...base };
  for (const k of SEED_KEYS) {
    const v = def.seeds[k];
    if (isHexColor(v)) out[k] = toHex(parseHex(v)!);
  }
  return out;
}

/** 半透明色叠在不透明底上（sRGB 里合成，与 tokens.css 的对比度检查一致） */
function over(top: string, alpha: number, base: string): string {
  const a = parseHex(top) ?? [0, 0, 0];
  const b = parseHex(base) ?? [0, 0, 0];
  return toHex([0, 1, 2].map((i) => a[i]! * alpha + b[i]! * (1 - alpha)) as RGB);
}

/**
 * 种子色推导出的令牌（不含主题包的覆盖）。
 * 先定所有底色，再让文字类颜色对它们可能落上去的每一种底都达标（正文 4.5:1，非文字 UI 3:1，控件描边 1.5:1），
 * 与 tokens.css 的对比度检查（scripts/theme-contrast-lib.mjs）同一套规则。
 */
export function deriveThemeTokens(
  def: Pick<CustomThemeDef, 'base' | 'seeds'>,
): Record<string, string> {
  const d = def.base === 'dark';
  const { accent: A, background: B, surface: S, text: T } = resolvedSeeds(def);
  const towardText = (c: string, t: number) => mixColor(c, T, t);
  const lighter = shiftLightness;

  // 底色
  const bgSubtle = towardText(B, d ? 0.03 : 0.02);
  const raised = d ? towardText(S, 0.04) : S;
  const sunken = d ? mixColor(B, S, 0.3) : B;
  const hover = towardText(S, d ? 0.04 : 0.06);
  const selectedBg = towardText(S, d ? 0.07 : 0.12);
  const userMsg = d ? towardText(S, 0.04) : bgSubtle;
  const grounds = [B, S, bgSubtle, raised, sunken];

  // 强调色：原色作 brand，非文字 UI（焦点环、图表）对底色至少 3:1
  const brand = ensureContrast(A, grounds, 3);
  const softAlpha = d ? 0.14 : 0.1;
  const soft = grounds.map((g) => over(brand, softAlpha, g));
  const textGrounds = [...grounds, hover, selectedBg, userMsg, ...soft];

  const muted = ensureContrast(mixColor(T, B, d ? 0.25 : 0.32), textGrounds, 4.5);
  const subtle = ensureContrast(mixColor(T, B, d ? 0.38 : 0.4), textGrounds, 4.5);
  const strong = ensureContrast(d ? lighter(brand, 0.06) : lighter(brand, -0.12), textGrounds, 4.5);

  // 强调色上放文字：按基底的习惯先选白字（浅色）/ 深字（深色），实在调不出来再换另一种
  const white = '#ffffff';
  const dark = mixColor(brand, '#000000', 0.85);
  const [first, second] = d ? [dark, white] : [white, dark];
  const on = contrastRatio(first, brand) >= 3 ? first : second;
  const accent = ensureContrast(brand, [on], 4.5);
  const accentHover = ensureContrast(d ? lighter(accent, 0.06) : lighter(accent, -0.03), [on], 4.5);
  const accentPressed = ensureContrast(lighter(accent, d ? -0.06 : -0.12), [on], 4.5);
  const accent2 = lighter(brand, d ? 0.07 : 0.15);
  const accent3 = lighter(brand, d ? 0.15 : 0.25);

  const border = towardText(S, d ? 0.07 : 0.1);
  const borderStrong = ensureContrast(towardText(S, d ? 0.15 : 0.19), [S, B, raised], 1.5);
  return {
    '--cd-color-bg': B,
    '--cd-color-bg-gradient': B,
    '--cd-color-bg-subtle': bgSubtle,
    '--cd-color-surface': S,
    '--cd-color-surface-raised': raised,
    '--cd-color-surface-sunken': sunken,
    '--cd-color-hover': hover,
    '--cd-color-active': towardText(S, d ? 0.08 : 0.11),
    '--cd-color-selected-bg': selectedBg,
    '--cd-color-selected-text': T,
    '--cd-color-user-msg': userMsg,
    '--cd-color-text': T,
    '--cd-color-text-muted': muted,
    '--cd-color-text-subtle': subtle,
    '--cd-color-text-on-accent': on,
    '--cd-color-border': border,
    '--cd-color-border-subtle': towardText(S, d ? 0.04 : 0.07),
    '--cd-color-border-strong': borderStrong,
    '--cd-color-border-focus': brand,
    '--cd-accent-rgb': rgbTriplet(accent),
    '--cd-accent-2-rgb': rgbTriplet(accent2),
    '--cd-accent-3-rgb': rgbTriplet(accent3),
    '--cd-color-accent': accent,
    '--cd-color-brand': brand,
    '--cd-color-accent-hover': accentHover,
    '--cd-color-accent-pressed': accentPressed,
    '--cd-color-accent-2': accent2,
    '--cd-color-accent-3': accent3,
    '--cd-color-accent-strong': strong,
    '--cd-color-accent-soft': rgba(brand, softAlpha),
    '--cd-color-btn-secondary-bg': S,
    '--cd-color-btn-secondary-border': towardText(S, d ? 0.09 : 0.12),
    '--cd-color-btn-secondary-text': mixColor(T, S, 0.08),
    '--cd-color-disabled-bg': towardText(S, d ? 0.04 : 0.07),
    '--cd-color-disabled-text': towardText(S, d ? 0.33 : 0.36),
    '--cd-color-switch-off': towardText(S, d ? 0.12 : 0.14),
    '--cd-color-input-bg': d ? mixColor(B, S, 0.4) : S,
    '--cd-color-neutral-soft': userMsg,
    '--cd-color-neutral-border': towardText(S, 0.12),
    '--cd-focus-ring': `0 0 0 2px ${rgba(brand, 1)}`,
    '--cd-input-ring': `0 0 0 2px ${rgba(brand, d ? 0.32 : 0.24)}`,
    '--cd-bubble-bg': rgba(S, 0.97),
    '--cd-bubble-border': d ? rgba(T, 0.1) : border,
    '--cd-bubble-text': T,
    '--cd-bubble-link': strong,
  };
}

/** 主题包覆盖令牌的值：只认颜色写法，拦下 url( / var( / 分号 / 花括号（Go 内核导入时同样校验） */
const COLOR_FN = /^(?:rgba?|hsla?|oklch)\(\s*[0-9.,%\s/+-]+\)$/i;
const HEX_ANY = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export const isSafeColorValue = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 64 && (HEX_ANY.test(v) || COLOR_FN.test(v));

/** 推导 + 覆盖后的完整令牌（某一套明暗，默认主套） */
export function customThemeTokens(
  def: CustomThemeDef,
  base: ThemeBase = def.base,
): Record<string, string> {
  const v = themeVariant(def, base);
  const out = deriveThemeTokens(v);
  for (const [k, val] of Object.entries(v.tokens ?? {})) {
    if (isThemeableToken(k) && isSafeColorValue(val)) out[k] = val;
  }
  return out;
}

export const CUSTOM_THEME_SELECTOR = ':root[data-theme-custom]';

export function customThemeCss(def: CustomThemeDef, base: ThemeBase = def.base): string {
  const body = Object.entries(customThemeTokens(def, base))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return `${CUSTOM_THEME_SELECTOR} {\n${body}\n}\n`;
}

/** 预览色卡：背景 / 表面 / 文字 / 强调（与 ThemeInfo.swatch 同序） */
export function customThemeSwatch(
  def: CustomThemeDef,
  base: ThemeBase = def.base,
): [string, string, string, string] {
  const s = resolvedSeeds(themeVariant(def, base));
  return [s.background, s.surface, s.text, s.accent];
}

export interface ContrastCheck {
  id: 'text-bg' | 'text-surface' | 'muted-surface' | 'on-accent' | 'link-surface';
  ratio: number;
  min: number;
  ok: boolean;
}

/** 编辑器里的对比度检查（推导之后的结果；正文与背景只提示不修正） */
export function contrastReport(def: CustomThemeDef, base: ThemeBase = def.base): ContrastCheck[] {
  const t = customThemeTokens(def, base);
  const pairs: [ContrastCheck['id'], string, string][] = [
    ['text-bg', t['--cd-color-text']!, t['--cd-color-bg']!],
    ['text-surface', t['--cd-color-text']!, t['--cd-color-surface']!],
    ['muted-surface', t['--cd-color-text-muted']!, t['--cd-color-surface']!],
    ['on-accent', t['--cd-color-text-on-accent']!, t['--cd-color-accent']!],
    ['link-surface', t['--cd-color-accent-strong']!, t['--cd-color-surface']!],
  ];
  return pairs.map(([id, fg, bg]) => {
    const parsed = isHexColor(fg) && isHexColor(bg);
    const ratio = parsed ? Math.round(contrastRatio(fg, bg) * 100) / 100 : 0;
    return { id, ratio, min: 4.5, ok: !parsed || ratio >= 4.5 };
  });
}

/** 显示名：当前语言 → 英文 → 中文 → 任一 */
export function customThemeName(def: Pick<CustomThemeDef, 'name'>, lang: string): string {
  const n = def.name ?? {};
  const key = lang.startsWith('zh') ? 'zh' : 'en';
  return n[key] || n.en || n.zh || Object.values(n).find(Boolean) || '';
}

const parseSeeds = (raw: unknown): Partial<Record<SeedKey, string>> => {
  const seeds: Partial<Record<SeedKey, string>> = {};
  for (const k of SEED_KEYS) {
    const v = (raw as Record<string, unknown> | undefined)?.[k];
    if (isHexColor(v)) seeds[k] = v;
  }
  return seeds;
};

const parseTokens = (raw: unknown): Record<string, string> | undefined => {
  const tokens: Record<string, string> = {};
  for (const [k, v] of Object.entries((raw as Record<string, unknown> | undefined) ?? {})) {
    if (isThemeableToken(k) && isSafeColorValue(v)) tokens[k] = v;
  }
  return Object.keys(tokens).length ? tokens : undefined;
};

const finite = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

/** 背景图只认内核存放的 chat-asset://themes/<文件名> */
export function parseThemeBackground(raw: unknown): ThemeBackground | undefined {
  const o = raw as Partial<ThemeBackground> | null | undefined;
  if (!o || typeof o.image !== 'string') return undefined;
  if (!/^chat-asset:\/\/themes\/[a-z0-9-]{1,48}\.(?:png|jpe?g|webp)$/.test(o.image))
    return undefined;
  return {
    image: o.image,
    blur: finite(o.blur, 0, 40, DEFAULT_THEME_BG.blur),
    opacity: finite(o.opacity, 0.05, 1, DEFAULT_THEME_BG.opacity),
  };
}

/** 视图侧的宽松校验：形状不对返回 null（Go 内核做完整校验） */
export function parseCustomTheme(v: unknown): CustomThemeDef | null {
  const o = v as Partial<CustomThemeDef> | null;
  if (!o || typeof o !== 'object') return null;
  if (!isCustomThemeId(o.id)) return null;
  if (o.base !== 'light' && o.base !== 'dark') return null;
  const name: Record<string, string> = {};
  for (const [k, val] of Object.entries((o.name as Record<string, unknown> | undefined) ?? {})) {
    if (typeof val === 'string') name[k] = val;
  }
  const tokens = parseTokens(o.tokens);
  const other = otherBase(o.base);
  const rawVariant = (o.variants as Record<string, unknown> | undefined)?.[other] as
    Partial<ThemeVariant> | undefined;
  const variantTokens = rawVariant ? parseTokens(rawVariant.tokens) : undefined;
  const background = parseThemeBackground(o.background);
  return {
    id: o.id,
    format: typeof o.format === 'number' ? o.format : CUSTOM_THEME_FORMAT,
    name,
    ...(typeof o.author === 'string' && o.author ? { author: o.author } : {}),
    base: o.base,
    seeds: parseSeeds(o.seeds),
    ...(tokens ? { tokens } : {}),
    ...(rawVariant && typeof rawVariant === 'object'
      ? {
          variants: {
            [other]: {
              seeds: parseSeeds(rawVariant.seeds),
              ...(variantTokens ? { tokens: variantTokens } : {}),
            },
          },
        }
      : {}),
    ...(background ? { background } : {}),
  };
}
