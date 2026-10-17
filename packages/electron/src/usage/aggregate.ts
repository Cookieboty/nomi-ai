/**
 * 用量聚合（纯函数）：时间范围 / 汇总 / 趋势 / 分布 / 排行 / 热力图 / 明细 / CSV。
 * 费用统一按 USD 算，币种换算交给界面（settings.currency + cnyPerUsd）。
 * 未定价的模型：token 照常统计，但不计入费用总额，并单独列出（提示去补价）。
 */
import { costUsd, findPrice } from './pricing';
import type { CustomPrice, PriceEntry, UsageRecord } from './types';

export type RangeId = 'today' | '7d' | '30d' | '90d';

export interface RangeSpec {
  id: RangeId;
  from: number;
  to: number;
  prevFrom: number;
  prevTo: number;
  /** 趋势图粒度：今日按小时，其余按天 */
  bucket: 'hour' | 'day';
  buckets: number;
}

const DAY = 86_400_000;

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 往前 / 往后推 n 个「本地日」（跨夏令时也落在本地零点） */
export function addDays(ts: number, n: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function rangeOf(id: RangeId, now: number): RangeSpec {
  const today = startOfDay(now);
  if (id === 'today') {
    return {
      id,
      from: today,
      to: addDays(today, 1),
      prevFrom: addDays(today, -1),
      prevTo: today,
      bucket: 'hour',
      buckets: 24,
    };
  }
  const days = id === '7d' ? 7 : id === '30d' ? 30 : 90;
  const from = addDays(today, -(days - 1));
  return {
    id,
    from,
    to: addDays(today, 1),
    prevFrom: addDays(from, -days),
    prevTo: from,
    bucket: 'day',
    buckets: days,
  };
}

export type PriceOf = (model: string) => ReturnType<typeof findPrice>;

export function makePriceOf(custom: CustomPrice[], synced: PriceEntry[] = []): PriceOf {
  const cache = new Map<string, ReturnType<typeof findPrice>>();
  return (model) => {
    if (!cache.has(model)) cache.set(model, findPrice(model, custom, synced));
    return cache.get(model)!;
  };
}

/** 一条记录的费用（USD）；未定价返回 null */
export function recordCost(r: UsageRecord, priceOf: PriceOf): number | null {
  const m = priceOf(r.model);
  return m ? costUsd(r, m.price) : null;
}

export const promptTokens = (r: UsageRecord): number => r.input + r.cacheRead + r.cacheWrite;
export const totalTokens = (r: UsageRecord): number => promptTokens(r) + r.output;

export interface Summary {
  costUsd: number;
  /** 输入 token（含缓存读写） */
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
  /** 估算（上游没返回 usage）的调用数 */
  estimatedCalls: number;
  /** 未定价模型（不计入费用） */
  unpriced: Array<{ model: string; tokens: number; calls: number }>;
}

export function summarize(recs: UsageRecord[], priceOf: PriceOf): Summary {
  const s: Summary = {
    costUsd: 0,
    input: 0,
    output: 0,
    total: 0,
    cacheRead: 0,
    cacheWrite: 0,
    calls: 0,
    estimatedCalls: 0,
    unpriced: [],
  };
  const un = new Map<string, { model: string; tokens: number; calls: number }>();
  for (const r of recs) {
    s.calls++;
    if (r.est) s.estimatedCalls++;
    s.input += promptTokens(r);
    s.output += r.output;
    s.cacheRead += r.cacheRead;
    s.cacheWrite += r.cacheWrite;
    const c = recordCost(r, priceOf);
    if (c === null) {
      const e = un.get(r.model) ?? { model: r.model, tokens: 0, calls: 0 };
      e.tokens += totalTokens(r);
      e.calls++;
      un.set(r.model, e);
    } else s.costUsd += c;
  }
  s.total = s.input + s.output;
  s.unpriced = [...un.values()].sort((a, b) => b.tokens - a.tokens);
  return s;
}

export interface SeriesPoint {
  /** 桶起点（ms） */
  t: number;
  input: number;
  output: number;
  tokens: number;
  costUsd: number;
  calls: number;
}

export function series(recs: UsageRecord[], range: RangeSpec, priceOf: PriceOf): SeriesPoint[] {
  const pts: SeriesPoint[] = [];
  for (let i = 0; i < range.buckets; i++) {
    const t = range.bucket === 'hour' ? range.from + i * 3_600_000 : addDays(range.from, i);
    pts.push({ t, input: 0, output: 0, tokens: 0, costUsd: 0, calls: 0 });
  }
  for (const r of recs) {
    if (r.ts < range.from || r.ts >= range.to) continue;
    let idx: number;
    if (range.bucket === 'hour') idx = Math.floor((r.ts - range.from) / 3_600_000);
    else idx = Math.floor((startOfDay(r.ts) - range.from) / DAY + 0.5);
    const p = pts[Math.min(Math.max(idx, 0), pts.length - 1)];
    if (!p) continue;
    p.input += promptTokens(r);
    p.output += r.output;
    p.tokens += totalTokens(r);
    p.calls++;
    p.costUsd += recordCost(r, priceOf) ?? 0;
  }
  return pts;
}

export interface BreakdownRow {
  key: string;
  tokens: number;
  input: number;
  output: number;
  costUsd: number;
  calls: number;
  /** 该分组里是否有未定价的调用（费用不完整） */
  hasUnpriced: boolean;
}

export type BreakdownBy = 'source' | 'provider' | 'model';

/** 模型名 → 厂商（日志里没有供应商字段时，用模型名推断；推断不出来返回「未知」） */
export function vendorOfModel(model: string): string | undefined {
  const m = model.toLowerCase();
  if (/claude/.test(m)) return 'Anthropic';
  if (/^(gpt|o\d|chatgpt|codex)/.test(m)) return 'OpenAI';
  if (/gemini|gemma/.test(m)) return 'Google';
  if (/deepseek/.test(m)) return 'DeepSeek';
  if (/qwen|qwq/.test(m)) return 'Qwen';
  if (/kimi|moonshot/.test(m)) return 'Moonshot';
  if (/glm/.test(m)) return 'Zhipu';
  if (/llama/.test(m)) return 'Meta';
  if (/mistral|mixtral|codestral/.test(m)) return 'Mistral';
  return undefined;
}

export interface Labels {
  /** 供应商 id → 显示名（Nomi 自己的 provider） */
  providerName: (id: string) => string | undefined;
}

export function providerOf(r: UsageRecord, labels?: Labels): string {
  if (r.provider) return labels?.providerName(r.provider) ?? r.provider;
  return vendorOfModel(r.model) ?? '';
}

export function breakdown(
  recs: UsageRecord[],
  by: BreakdownBy,
  priceOf: PriceOf,
  labels?: Labels,
): BreakdownRow[] {
  const m = new Map<string, BreakdownRow>();
  for (const r of recs) {
    const key = by === 'source' ? r.source : by === 'model' ? r.model : providerOf(r, labels);
    const row = m.get(key) ?? {
      key,
      tokens: 0,
      input: 0,
      output: 0,
      costUsd: 0,
      calls: 0,
      hasUnpriced: false,
    };
    row.tokens += totalTokens(r);
    row.input += promptTokens(r);
    row.output += r.output;
    row.calls++;
    const c = recordCost(r, priceOf);
    if (c === null) row.hasUnpriced = true;
    else row.costUsd += c;
    m.set(key, row);
  }
  return [...m.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
}

export interface HeatDay {
  /** YYYY-MM-DD（本地日） */
  date: string;
  tokens: number;
  costUsd: number;
  calls: number;
}

export function dateKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 近 365 天（含今天）每天一格，没有用量的天也返回（0） */
export function heatmap(recs: UsageRecord[], now: number, priceOf: PriceOf, days = 365): HeatDay[] {
  const today = startOfDay(now);
  const first = addDays(today, -(days - 1));
  const byDay = new Map<string, HeatDay>();
  for (let i = 0; i < days; i++) {
    const k = dateKey(addDays(first, i));
    byDay.set(k, { date: k, tokens: 0, costUsd: 0, calls: 0 });
  }
  for (const r of recs) {
    if (r.ts < first || r.ts >= addDays(today, 1)) continue;
    const d = byDay.get(dateKey(r.ts));
    if (!d) continue;
    d.tokens += totalTokens(r);
    d.calls++;
    d.costUsd += recordCost(r, priceOf) ?? 0;
  }
  return [...byDay.values()];
}

// ---------------------------------------------------------------- 明细

export type DetailSort = 'ts' | 'tokens' | 'cost' | 'model' | 'source';

export interface DetailQuery {
  from: number;
  to: number;
  source?: string;
  model?: string;
  session?: string;
  sort?: DetailSort;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface DetailRow {
  key: string;
  ts: number;
  source: string;
  provider: string;
  model: string;
  session?: string;
  project?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  /** null = 未定价 */
  costUsd: number | null;
  estimated: boolean;
}

export interface DetailResult {
  rows: DetailRow[];
  total: number;
  /** 筛选命中的汇总 */
  summary: Summary;
  facets: { sources: string[]; models: string[]; sessions: Array<{ id: string; label: string }> };
}

export function toRow(r: UsageRecord, priceOf: PriceOf, labels?: Labels): DetailRow {
  return {
    key: r.key,
    ts: r.ts,
    source: r.source,
    provider: providerOf(r, labels),
    model: r.model,
    session: r.session,
    project: r.project,
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead,
    cacheWrite: r.cacheWrite,
    tokens: totalTokens(r),
    costUsd: recordCost(r, priceOf),
    estimated: !!r.est,
  };
}

export function details(
  all: UsageRecord[],
  q: DetailQuery,
  priceOf: PriceOf,
  labels?: Labels,
): DetailResult {
  const inRange = all.filter((r) => r.ts >= q.from && r.ts < q.to);
  const facets = {
    sources: [...new Set(inRange.map((r) => r.source))].sort(),
    models: [...new Set(inRange.map((r) => r.model))].sort(),
    sessions: [] as Array<{ id: string; label: string }>,
  };
  const sess = new Map<string, { id: string; label: string; tokens: number }>();
  for (const r of inRange) {
    if (!r.session) continue;
    const e = sess.get(r.session) ?? {
      id: r.session,
      label: `${r.project ? `${r.project} · ` : ''}${r.session.slice(0, 8)}`,
      tokens: 0,
    };
    e.tokens += totalTokens(r);
    sess.set(r.session, e);
  }
  facets.sessions = [...sess.values()]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 100)
    .map(({ id, label }) => ({ id, label }));

  const filtered = inRange.filter(
    (r) =>
      (!q.source || r.source === q.source) &&
      (!q.model || r.model === q.model) &&
      (!q.session || r.session === q.session),
  );
  const rows = filtered.map((r) => toRow(r, priceOf, labels));
  const dir = q.dir === 'asc' ? 1 : -1;
  const sort = q.sort ?? 'ts';
  rows.sort((a, b) => {
    switch (sort) {
      case 'tokens':
        return (a.tokens - b.tokens) * dir;
      case 'cost':
        return ((a.costUsd ?? -1) - (b.costUsd ?? -1)) * dir;
      case 'model':
        return a.model.localeCompare(b.model) * dir;
      case 'source':
        return a.source.localeCompare(b.source) * dir;
      default:
        return (a.ts - b.ts) * dir;
    }
  });
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(Math.max(1, q.limit ?? 100), 1000);
  return {
    rows: rows.slice(offset, offset + limit),
    total: rows.length,
    summary: summarize(filtered, priceOf),
    facets,
  };
}

const csvCell = (v: string | number | null | undefined): string => {
  const s = v === null || v === undefined ? '' : String(v);
  // 防 CSV 注入：以 = + - @ 开头的文本前置单引号
  const safe = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(rows: DetailRow[], currency: 'USD' | 'CNY', cnyPerUsd: number): string {
  const rate = currency === 'CNY' ? cnyPerUsd : 1;
  const head = [
    'time',
    'source',
    'provider',
    'model',
    'session',
    'project',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'total_tokens',
    `cost_${currency.toLowerCase()}`,
    'priced',
    'estimated',
  ];
  const out = [head.join(',')];
  for (const r of rows) {
    out.push(
      [
        new Date(r.ts).toISOString(),
        r.source,
        r.provider,
        r.model,
        r.session ?? '',
        r.project ?? '',
        r.input,
        r.output,
        r.cacheRead,
        r.cacheWrite,
        r.tokens,
        r.costUsd === null ? '' : +(r.costUsd * rate).toFixed(6),
        r.costUsd === null ? 'no' : 'yes',
        r.estimated ? 'yes' : 'no',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${out.join('\n')}\n`;
}
