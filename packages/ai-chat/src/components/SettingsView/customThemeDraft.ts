/**
 * 自定义主题编辑器的草稿：一套或两套明暗（各自 4 个种子色 + 覆盖令牌）、背景图。
 * 纯函数，编辑器只管把它画出来；单测在 tests/customThemeDraft.test.ts。
 *
 * - 只有一套时，明暗按背景色自动判断（深背景 = 深色）；
 * - 打开「浅色、深色各一套」后两套的明暗固定，另一套从对应基底主题起步、沿用强调色；
 * - 关掉时只留正在编辑的那套。
 */
import {
  BASE_SEEDS,
  CUSTOM_THEME_FORMAT,
  SEED_KEYS,
  isHexColor,
  isSafeColorValue,
  isThemeableToken,
  otherBase,
  parseHex,
  resolvedSeeds,
  suggestBase,
  themeVariant,
  toHex,
  type CustomThemeDef,
  type SeedKey,
  type ThemeBackground,
  type ThemeBase,
  type ThemeVariant,
} from '@nomi-ai/ui';

export interface VariantDraft {
  /** 输入框里的原样文字（可能是半截） */
  seeds: Record<SeedKey, string>;
  /** 覆盖令牌：原样文字，空 = 用推导值 */
  tokens: Record<string, string>;
}

export interface ThemeDraft {
  /** 主套的明暗 */
  primary: ThemeBase;
  dual: boolean;
  editing: ThemeBase;
  variants: Partial<Record<ThemeBase, VariantDraft>>;
  background: ThemeBackground | null;
}

export function initDraft(
  initial: CustomThemeDef | null,
  startSeeds: Record<SeedKey, string>,
): ThemeDraft {
  if (!initial) {
    const primary = suggestBase(startSeeds.background);
    return {
      primary,
      dual: false,
      editing: primary,
      variants: { [primary]: { seeds: { ...startSeeds }, tokens: {} } },
      background: null,
    };
  }
  const variants: ThemeDraft['variants'] = {};
  const other = otherBase(initial.base);
  const dual = !!initial.variants?.[other];
  for (const b of dual ? [initial.base, other] : [initial.base]) {
    const v = themeVariant(initial, b);
    variants[b] = { seeds: resolvedSeeds(v), tokens: { ...(v.tokens ?? {}) } };
  }
  return {
    primary: initial.base,
    dual,
    editing: initial.base,
    variants,
    background: initial.background ?? null,
  };
}

export const currentVariant = (d: ThemeDraft): VariantDraft => d.variants[d.editing]!;

/** 改一个种子色；只有一套时背景改了明暗要跟着变 */
export function setSeed(d: ThemeDraft, key: SeedKey, value: string): ThemeDraft {
  const cur = currentVariant(d);
  const next: VariantDraft = { ...cur, seeds: { ...cur.seeds, [key]: value.trim() } };
  if (!d.dual && key === 'background' && isHexColor(next.seeds.background)) {
    const base = suggestBase(next.seeds.background);
    if (base !== d.editing)
      return { ...d, primary: base, editing: base, variants: { [base]: next } };
  }
  return { ...d, variants: { ...d.variants, [d.editing]: next } };
}

/** 一次填入一组颜色（按 SEED_KEYS 顺序） */
export function setPalette(d: ThemeDraft, colors: string[]): ThemeDraft {
  let next = d;
  SEED_KEYS.forEach((k, i) => {
    if (colors[i]) next = setSeed(next, k, colors[i]!);
  });
  return next;
}

export function setToken(d: ThemeDraft, token: string, value: string): ThemeDraft {
  const cur = currentVariant(d);
  const tokens = { ...cur.tokens };
  if (value.trim()) tokens[token] = value.trim();
  else delete tokens[token];
  return { ...d, variants: { ...d.variants, [d.editing]: { ...cur, tokens } } };
}

/** 打开 / 关掉「浅色、深色各一套」 */
export function setDual(d: ThemeDraft, dual: boolean): ThemeDraft {
  if (dual === d.dual) return d;
  if (!dual) {
    const keep = currentVariant(d);
    return { ...d, dual, primary: d.editing, variants: { [d.editing]: keep } };
  }
  const other = otherBase(d.primary);
  const cur = d.variants[d.primary]!;
  const accent = isHexColor(cur.seeds.accent) ? cur.seeds.accent : BASE_SEEDS[other].accent;
  return {
    ...d,
    dual,
    variants: {
      ...d.variants,
      [other]: d.variants[other] ?? { seeds: { ...BASE_SEEDS[other], accent }, tokens: {} },
    },
  };
}

export const setEditing = (d: ThemeDraft, editing: ThemeBase): ThemeDraft =>
  d.variants[editing] ? { ...d, editing } : d;

export const setBackground = (d: ThemeDraft, background: ThemeBackground | null): ThemeDraft => ({
  ...d,
  background,
});

const toVariant = (v: VariantDraft): ThemeVariant => {
  const seeds: ThemeVariant['seeds'] = {};
  for (const k of SEED_KEYS) if (isHexColor(v.seeds[k])) seeds[k] = toHex(parseHex(v.seeds[k])!);
  const tokens: Record<string, string> = {};
  for (const [k, val] of Object.entries(v.tokens))
    if (isThemeableToken(k) && isSafeColorValue(val)) tokens[k] = val;
  return { seeds, ...(Object.keys(tokens).length ? { tokens } : {}) };
};

/** 草稿 → 主题定义（无效的种子 / 令牌不进去；预览与保存都用它） */
export function draftToTheme(
  d: ThemeDraft,
  id: string,
  name: Record<string, string>,
  author?: string,
): CustomThemeDef {
  const main = toVariant(d.variants[d.primary]!);
  const other = otherBase(d.primary);
  const alt = d.dual && d.variants[other] ? toVariant(d.variants[other]!) : null;
  return {
    id,
    format: CUSTOM_THEME_FORMAT,
    name,
    ...(author ? { author } : {}),
    base: d.primary,
    ...main,
    ...(alt ? { variants: { [other]: alt } } : {}),
    ...(d.background ? { background: d.background } : {}),
  };
}

export interface DraftProblem {
  base: ThemeBase;
  kind: 'seed' | 'token';
  key: string;
}

/** 输入框里还有不合法的值（保存前拦下，并切到出问题的那套） */
export function draftProblems(d: ThemeDraft): DraftProblem[] {
  const out: DraftProblem[] = [];
  for (const [base, v] of Object.entries(d.variants) as [ThemeBase, VariantDraft][]) {
    for (const k of SEED_KEYS)
      if (!isHexColor(v.seeds[k])) out.push({ base, kind: 'seed', key: k });
    for (const [k, val] of Object.entries(v.tokens))
      if (!isSafeColorValue(val)) out.push({ base, kind: 'token', key: k });
  }
  return out;
}

/** 双套时，这套的背景明暗和它被当成的明暗对不上（深色那套配了浅背景） */
export function baseMismatch(d: ThemeDraft): boolean {
  const bg = currentVariant(d).seeds.background;
  return d.dual && isHexColor(bg) && suggestBase(bg) !== d.editing;
}
