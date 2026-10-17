/**
 * 内置主流模型单价表（USD / 1M tokens）+ 别名 / 前缀匹配 + 费用计算。
 *
 * 数据来源：各家官方定价页（Anthropic / OpenAI / Google），整理于 PRICING_TABLE_DATE。
 * 原则：没有把握的模型不放进表里 —— 查不到就是「未定价」，不估价、不编造；
 * 用户可在设置里改价或新增自定义模型（0 也是合法的价格，例如本地模型）。
 * 按上下文长度分档的模型带 tiers：单次请求的提示词 token 超过档位阈值时整条请求改用高档价。
 * （本表只收录官方长上下文档；高峰时段等其它分段计价不收录。）
 */
import type { CustomPrice, ModelPrice, PriceEntry, PriceTier, UsageRecord } from './types';

export const PRICING_TABLE_DATE = '2026-10-16';

const p = (
  model: string,
  input: number,
  output: number,
  cacheRead?: number,
  cacheWrite?: number,
  note?: string,
  tiers?: PriceTier[],
): PriceEntry => ({
  model,
  input,
  output,
  ...(cacheRead !== undefined ? { cacheRead } : {}),
  ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  ...(note ? { note } : {}),
  ...(tiers ? { tiers } : {}),
});

/** 长上下文档：请求提示词 > size 时的价格 */
const tier = (
  size: number,
  input: number,
  output: number,
  cacheRead?: number,
  cacheWrite?: number,
): PriceTier => ({
  size,
  input,
  output,
  ...(cacheRead !== undefined ? { cacheRead } : {}),
  ...(cacheWrite !== undefined ? { cacheWrite } : {}),
});

export const BUILTIN_PRICES: PriceEntry[] = [
  // ---- Anthropic（缓存写按 5 分钟档）----
  p('claude-fable-5-1', 10, 50, 0.25, 12.5),
  p('claude-fable-5', 10, 50, 1, 12.5),
  p('claude-opus-5-5', 4, 20, 0.2, 5),
  p('claude-opus-5', 5, 25, 0.5, 6.25),
  p('claude-opus-4-8', 5, 25, 0.5, 6.25),
  p('claude-opus-4-7', 5, 25, 0.5, 6.25),
  p('claude-opus-4-6', 5, 25, 0.5, 6.25),
  p('claude-opus-4-5', 5, 25, 0.5, 6.25),
  p('claude-opus-4-1', 15, 75, 1.5, 18.75),
  p('claude-opus-4', 15, 75, 1.5, 18.75),
  p('claude-sonnet-5-5', 2, 10, 0.1, 2.5),
  p('claude-sonnet-5', 2, 10, 0.2, 2.5),
  p('claude-sonnet-4-6', 3, 15, 0.3, 3.75),
  p('claude-sonnet-4-5', 3, 15, 0.3, 3.75),
  p('claude-sonnet-4', 3, 15, 0.3, 3.75),
  p('claude-haiku-4-5', 1, 5, 0.1, 1.25),
  p('claude-3-5-haiku', 0.8, 4, 0.08, 1),
  // ---- OpenAI ----
  p('gpt-6-astra', 10, 50, 1, 12.5, undefined, [tier(272_000, 20, 75, 2, 25)]),
  p('gpt-6-1-sol', 2, 10, 0.1, 2.5, undefined, [tier(272_000, 4, 15, 0.2, 5)]),
  p('gpt-6-sol', 2, 10, 0.2, 2.5, undefined, [tier(272_000, 4, 15, 0.4, 5)]),
  p('gpt-6-luna', 0.1, 0.5, 0.01, 0.125, undefined, [tier(272_000, 0.2, 0.75, 0.02, 0.25)]),
  p('gpt-5-6-sol', 4, 20, 0.4, 5, undefined, [tier(272_000, 8, 30, 0.8, 10)]),
  p('gpt-5-6-terra', 2, 12, 0.2, 2.5, undefined, [tier(272_000, 4, 18, 0.4, 5)]),
  p('gpt-5-6-luna', 0.2, 1.2, 0.02, 0.25, undefined, [tier(272_000, 0.4, 1.8, 0.04, 0.5)]),
  p('gpt-5-5', 5, 30, 0.5, undefined, undefined, [tier(272_000, 10, 45, 1)]),
  p('gpt-5-4-mini', 0.75, 4.5, 0.075),
  p('gpt-5-4-nano', 0.2, 1.25, 0.02),
  p('gpt-5-4', 2.5, 15, 0.25, undefined, undefined, [tier(272_000, 5, 22.5, 0.5)]),
  p('gpt-5-3-codex', 1.75, 14, 0.175),
  p('gpt-5-2', 1.75, 14, 0.175),
  p('gpt-5-1', 1.25, 10, 0.125),
  p('gpt-5-mini', 0.25, 2, 0.025),
  p('gpt-5-nano', 0.05, 0.4, 0.005),
  p('gpt-5', 1.25, 10, 0.125),
  p('gpt-4-1-mini', 0.4, 1.6, 0.1),
  p('gpt-4-1-nano', 0.1, 0.4, 0.025),
  p('gpt-4-1', 2, 8, 0.5),
  p('gpt-4o-2024-05-13', 5, 15),
  p('gpt-4o-mini', 0.15, 0.6, 0.075),
  p('gpt-4o', 2.5, 10, 1.25),
  p('o4-mini', 1.1, 4.4, 0.275),
  p('o3-mini', 1.1, 4.4, 0.55),
  p('o3', 2, 8, 0.5),
  p('o1', 15, 60, 7.5),
  // ---- Google Gemini（>200K 提示词走长上下文档）----
  p('gemini-3-1-pro-preview', 2, 12, 0.2, undefined, undefined, [tier(200_000, 4, 18, 0.4)]),
  p('gemini-3-1-flash-lite', 0.25, 1.5, 0.025),
  p('gemini-3-flash-preview', 0.5, 3, 0.05),
  p('gemini-2-5-pro', 1.25, 10, 0.125, undefined, undefined, [tier(200_000, 2.5, 15, 0.25)]),
  p('gemini-2-5-flash-lite', 0.1, 0.4, 0.01),
  p('gemini-2-5-flash', 0.3, 2.5, 0.03),
];

/**
 * 模型名规范化：小写、去供应商前缀（anthropic/、openai/、models/ …）、去 [1m] 等后缀标记、
 * 版本号里的点统一成 `-`（claude-opus-4.5 → claude-opus-4-5）。
 */
export function normalizeModel(raw: string): string {
  let s = (raw || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/\[[^\]]*\]$/, '').trim();
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/^(models|anthropic|openai|google|azure)[.:]/, '');
  // 点号版本 → 连字符；其它标点保持
  s = s.replace(/(\d)\.(\d)/g, '$1-$2').replace(/_/g, '-');
  return s;
}

/** 允许跟在已知模型名后面的「纯版本后缀」：日期、-latest、-preview、4 位日期码；其余视为另一个模型 */
export const VERSION_SUFFIX = /^(-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4}|latest|preview|\d{2}-\d{4}))*$/;

export type PriceSource = 'custom' | 'sync' | 'builtin';

export interface PriceMatch {
  price: ModelPrice;
  /** 命中的表项（规范化名） */
  matched: string;
  /** 用户自定义的价格（= source === 'custom'，保留给旧调用方） */
  custom: boolean;
  /** 价格来源：用户自定义 > models.dev 同步 > 内置 */
  source: PriceSource;
  note?: string;
}

type Priced = { model: string } & ModelPrice & { note?: string };

const isMatch = (name: string, key: string): boolean =>
  name === key || (name.startsWith(key) && VERSION_SUFFIX.test(name.slice(key.length)));

const toMatch = (e: Priced, source: PriceSource): PriceMatch => ({
  price: {
    input: e.input,
    output: e.output,
    ...(e.cacheRead !== undefined ? { cacheRead: e.cacheRead } : {}),
    ...(e.cacheWrite !== undefined ? { cacheWrite: e.cacheWrite } : {}),
    ...(e.cacheWrite1h !== undefined ? { cacheWrite1h: e.cacheWrite1h } : {}),
    ...(e.tiers?.length ? { tiers: e.tiers } : {}),
  },
  matched: normalizeModel(e.model),
  custom: source === 'custom',
  source,
  ...(e.note ? { note: e.note } : {}),
});

/**
 * 找单价，优先级：用户自定义 > models.dev 同步 > 内置。
 * - 自定义：精确 → 前缀，命中就用；
 * - 同步 / 内置：放在一起找「最长的匹配名」（精确 → 最长前缀 + 版本后缀），更具体的表项赢；
 *   同样具体时同步价赢（同步更新）。这样同步表里一个泛化的短名字不会盖掉内置里专门定价的日期版本。
 * 找不到返回 null = 「未定价」。
 */
export function findPrice(
  model: string,
  custom: CustomPrice[] = [],
  synced: PriceEntry[] = [],
): PriceMatch | null {
  const name = normalizeModel(model);
  if (!name) return null;
  const best = (list: Priced[]): { e: Priced; len: number } | null => {
    let hit: { e: Priced; len: number } | null = null;
    for (const e of list) {
      const key = normalizeModel(e.model);
      if (!key || !isMatch(name, key)) continue;
      if (!hit || hit.len < key.length) hit = { e, len: key.length };
    }
    return hit;
  };
  const c = best(custom);
  if (c) return toMatch(c.e, 'custom');
  const s = synced.length ? best(synced) : null;
  const b = best(BUILTIN_PRICES);
  if (s && (!b || s.len >= b.len)) return toMatch(s.e, 'sync');
  return b ? toMatch(b.e, 'builtin') : null;
}

/** 快速模式（Claude usage.speed === 'fast'）的倍率：Anthropic 的缓存价是输入价的倍数且与之叠加，所以整条记录一起翻倍 */
export const FAST_MULTIPLIER = 2;
/** 1 小时缓存写相对输入价的倍数（5 分钟档是 1.25 倍，已在表里直接标价） */
export const CACHE_WRITE_1H_FACTOR = 2;

/**
 * 缓存读 / 写没有单独标价时：缓存读按输入价、缓存写按输入价（保守，不凭空打折也不加价）。
 * 缓存写分档：cacheWrite1h 部分按 1 小时档价（表里没标就取 2 × 输入价；该模型连缓存写价都没有就按输入价），
 * 其余（含拆不出分档的旧账本记录）按 5 分钟档。
 */
export function costUsd(
  r: Pick<UsageRecord, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> &
    Partial<Pick<UsageRecord, 'cacheWrite1h' | 'fast'>>,
  pr: ModelPrice,
): number {
  const M = 1_000_000;
  const eff = tierPrice(pr, r.input + r.cacheRead + r.cacheWrite);
  const w1h = Math.min(Math.max(0, r.cacheWrite1h ?? 0), r.cacheWrite);
  const w5m = r.cacheWrite - w1h;
  const price1h =
    eff.cacheWrite1h ??
    (eff.cacheWrite !== undefined ? eff.input * CACHE_WRITE_1H_FACTOR : eff.input);
  const base =
    (r.input * eff.input +
      r.output * eff.output +
      r.cacheRead * (eff.cacheRead ?? eff.input) +
      w5m * (eff.cacheWrite ?? eff.input) +
      w1h * price1h) /
    M;
  return r.fast ? base * FAST_MULTIPLIER : base;
}

/**
 * 长上下文分档：这一次请求的提示词 token（含缓存读写）严格大于某档 size 时，用 size 最大的已超过的那一档；
 * 档里没写的缓存价沿用基础价。按「单次请求」判断，账本里每条记录就是一次请求，不是日聚合。
 */
export function tierPrice(pr: ModelPrice, promptTokens: number): Omit<ModelPrice, 'tiers'> {
  const { tiers, ...baseOnly } = pr;
  if (!tiers?.length) return baseOnly;
  let hit: PriceTier | null = null;
  for (const t of tiers) if (promptTokens > t.size && (!hit || t.size > hit.size)) hit = t;
  if (!hit) return baseOnly;
  const { size: _size, ...rest } = hit;
  void _size;
  return { ...baseOnly, ...rest };
}

/** 默认 CNY 汇率（1 USD = ? CNY）：仅是占位常量，界面上标注「可自定义」 */
export const DEFAULT_CNY_PER_USD = 7.2;

export function sanitizeCustomPrices(raw: unknown): CustomPrice[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, CustomPrice>();
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const model = typeof o.model === 'string' ? normalizeModel(o.model) : '';
    const input = num(o.input);
    const output = num(o.output);
    if (!model || input === undefined || output === undefined) continue;
    const cacheRead = num(o.cacheRead);
    const cacheWrite = num(o.cacheWrite);
    const cacheWrite1h = num(o.cacheWrite1h);
    out.set(model, {
      model,
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
    });
  }
  return [...out.values()];
}
