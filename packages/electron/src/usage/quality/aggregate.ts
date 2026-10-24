/**
 * 模型质量的聚合（docs/design/model-quality.md §2、§3）：筛选、分组、比率、分位数、时间序列。
 * 纯函数，不做 IO；记录里的 input 是「未命中缓存的输入」（转换时已统一口径，见 fromGateway.ts）。
 */
import type {
  QualityAttempt,
  QualityDimension,
  QualityDist,
  QualityOutcome,
  QualityQuery,
  QualityRecord,
  QualityRequestsQuery,
  QualityResult,
  QualitySeries,
  QualitySeriesQuery,
  QualityStats,
  QualityTiming,
  QualityTokens,
} from '@nomi-ai/types';

/** 样本少于这个数时界面只显示中位数 */
export const MIN_SAMPLES = 20;
/** 精确分位数（排序）的样本上限；超过时等距抽样 */
const EXACT_PERCENTILE_MAX = 50_000;

/** 维度取值的显示名（供应商 / Key 的名字等）；不给就用键本身 */
export type QualityLabelOf = (dim: QualityDimension, key: string) => string | undefined;

/** 断流：已开始输出后没有正常结束 */
const BREAK_OUTCOMES: ReadonlySet<QualityOutcome> = new Set([
  'stream-break',
  'idle-timeout',
  'cli-exit',
]);

/**
 * 模型族：去掉 `供应商/` 前缀与日期 / 版本快照后缀，小写。用于「同一模型跨供应商」对比；
 * 只去掉明确的快照后缀（-20250514、-2025-05-14、@20250514、-latest），版本号本身（v4.1、4o）保留。
 */
export function modelFamily(model: string | undefined): string | undefined {
  if (!model) return undefined;
  let m = model.trim().toLowerCase();
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  m = m
    .replace(/[-@](?:\d{4}-\d{2}-\d{2}|\d{8})$/, '')
    .replace(/-latest$/, '')
    .replace(/:[\w.-]+$/, '');
  return m || undefined;
}

/**
 * 统计单位：请求视角一条记录一个单位；尝试视角（countBy: 'attempt'）一次尝试一个单位，
 * 回退前失败的 Key 也会记一次失败（§2.1）。时间与 token 只有最后一次（产出结果的）尝试才有。
 */
interface Unit {
  r: QualityRecord;
  provider?: string;
  keyId?: string;
  model?: string;
  outcome: QualityOutcome;
  status?: number;
  timing: QualityTiming;
  tokens: QualityTokens;
  cost?: number;
  final: boolean;
}

function unitsOf(records: readonly QualityRecord[], countBy: 'request' | 'attempt'): Unit[] {
  const out: Unit[] = [];
  for (const r of records) {
    const base: Unit = {
      r,
      provider: r.provider,
      keyId: r.keyId,
      model: r.model,
      outcome: r.outcome,
      status: r.status,
      timing: r.timing,
      tokens: r.tokens,
      cost: r.cost,
      final: true,
    };
    const attempts = r.attempts ?? [];
    if (countBy !== 'attempt' || r.layer !== 'gateway' || attempts.length <= 1) {
      out.push(base);
      continue;
    }
    attempts.forEach((a: QualityAttempt, i) => {
      if (i === attempts.length - 1) {
        out.push({
          ...base,
          provider: a.provider || r.provider,
          keyId: a.keyId ?? r.keyId,
          model: a.model || r.model,
        });
        return;
      }
      out.push({
        r,
        provider: a.provider,
        keyId: a.keyId,
        model: a.model,
        outcome: a.outcome,
        status: a.status,
        timing: { endMs: a.ms, ...(a.headersMs !== undefined ? { headersMs: a.headersMs } : {}) },
        tokens: {},
        final: false,
      });
    });
  }
  return out;
}

/** 一个单位在某个维度上的取值；没有值返回 null（不进任何分组） */
function dimOf(u: Unit, dim: QualityDimension): string | null {
  const r = u.r;
  switch (dim) {
    case 'provider':
      return u.provider ?? null;
    case 'key':
      return u.keyId ? `${u.provider ?? ''}\u0000${u.keyId}` : null;
    case 'model':
      return u.model ?? null;
    case 'modelFamily':
      return r.modelFamily ?? modelFamily(r.upstreamModel ?? u.model) ?? null;
    case 'client':
      return r.client || null;
    case 'source':
      return r.source || null;
    case 'protocol':
      return r.ingress && r.wire ? `${r.ingress}→${r.wire}` : null;
    case 'resolved':
      return r.resolved ?? null;
    case 'outcome':
      return u.outcome;
  }
}

function matches(u: Unit, filters: QualityQuery['filters']): boolean {
  if (!filters) return true;
  for (const [dim, values] of Object.entries(filters) as Array<[QualityDimension, string[]]>) {
    if (!values?.length) continue;
    const v = dimOf(u, dim);
    if (v === null) return false;
    // Key 维度按「供应商 + Key」存，筛选值只给 Key id 时也认
    if (
      dim === 'key' ? !values.some((x) => x === v || v.endsWith(`\u0000${x}`)) : !values.includes(v)
    )
      return false;
  }
  return true;
}

/** 记录时间范围 + 口径（不给 layer = gateway） */
export function inRange(
  records: readonly QualityRecord[],
  q: Pick<QualityQuery, 'from' | 'to' | 'layer'>,
): QualityRecord[] {
  const layer = q.layer ?? 'gateway';
  return records.filter((r) => r.layer === layer && r.ts >= q.from && r.ts < q.to);
}

/** 分布：均值与 p50 / p90 / p99（最近秩法） */
export function dist(values: readonly number[]): QualityDist {
  // 单遍：过滤非法值、求和，直接填进 Float64Array（内置数值排序比带比较函数的 Array.sort 快得多）
  const xs = new Float64Array(values.length);
  let n = 0;
  let sum = 0;
  for (const v of values)
    if (Number.isFinite(v) && v >= 0) {
      xs[n++] = v;
      sum += v;
    }
  if (!n) return { n: 0 };
  let sample = xs.subarray(0, n);
  if (n > EXACT_PERCENTILE_MAX) {
    const step = n / EXACT_PERCENTILE_MAX;
    sample = Float64Array.from(
      { length: EXACT_PERCENTILE_MAX },
      (_, i) => xs[Math.floor(i * step)]!,
    );
  }
  sample.sort();
  const at = (p: number) => sample[Math.min(sample.length - 1, Math.ceil(p * sample.length) - 1)]!;
  return { n, mean: sum / n, p50: at(0.5), p90: at(0.9), p99: at(0.99) };
}

const num = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const rate = (a: number, b: number) => (b > 0 ? a / b : undefined);

/** 生成时长（第一个 → 最后一个内容事件），拿不到返回 null */
function genMs(t: QualityTiming): number | null {
  return t.firstContentMs !== undefined &&
    t.lastContentMs !== undefined &&
    t.lastContentMs >= t.firstContentMs
    ? t.lastContentMs - t.firstContentMs
    : null;
}

function statsOf(
  units: readonly Unit[],
  key: string,
  label: string,
  q: Pick<QualityQuery, 'cancelInDenominator' | 'includeRejected'>,
): QualityStats {
  const failures: Partial<Record<QualityOutcome, number>> = {};
  let ok = 0;
  let failed = 0;
  let cancelled = 0;
  let cancelBeforeFirst = 0;
  let cancelDuring = 0;
  let rejected = 0;
  let committed = 0;
  let streamBreak = 0;
  let fallback = 0;
  let burst = 0;
  let attempts = 0;
  let cacheTotal = 0;
  let cacheRead = 0;
  let cacheReqs = 0;
  let cacheHitReqs = 0;
  let cost = 0;
  let priced = false;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const ttfb: number[] = [];
  const ttft: number[] = [];
  const ttftText: number[] = [];
  const tpot: number[] = [];
  const e2e: number[] = [];
  const tps: number[] = [];
  for (const u of units) {
    const r = u.r;
    attempts += u.final ? Math.max(1, r.attempts?.length ?? 1) : 1;
    if (u.final && (r.attempts?.length ?? 0) > 1 && u.outcome === 'ok') fallback++;
    switch (u.outcome) {
      case 'ok':
        ok++;
        break;
      case 'client-cancel':
        cancelled++;
        if (r.cancelPhase === 'during') cancelDuring++;
        else cancelBeforeFirst++;
        break;
      case 'request-rejected':
        rejected++;
        if (q.includeRejected) {
          failed++;
          failures[u.outcome] = (failures[u.outcome] ?? 0) + 1;
        }
        break;
      default:
        failed++;
        failures[u.outcome] = (failures[u.outcome] ?? 0) + 1;
    }
    const t = u.timing;
    if (t.headersMs !== undefined) ttfb.push(t.headersMs);
    if (u.final && r.stream && t.firstContentMs !== undefined) {
      committed++;
      if (BREAK_OUTCOMES.has(u.outcome)) streamBreak++;
    }
    if (u.final && r.burst) burst++;
    if (u.outcome === 'ok') {
      if (t.firstContentMs !== undefined) ttft.push(t.firstContentMs);
      if (t.firstTextMs !== undefined) ttftText.push(t.firstTextMs);
      e2e.push(t.endMs);
      const out = num(u.tokens.output);
      const g = genMs(t);
      if (r.stream && !r.burst && g !== null && g > 0 && out >= 2) {
        tpot.push(g / (out - 1));
        tps.push(out / (g / 1000));
      }
    }
    const tk = u.tokens;
    tokens.input += num(tk.input);
    tokens.output += num(tk.output);
    tokens.cacheRead += num(tk.cacheRead);
    tokens.cacheWrite += num(tk.cacheWrite);
    tokens.reasoning += num(tk.reasoning);
    const total = num(tk.input) + num(tk.cacheRead) + num(tk.cacheWrite);
    if (total > 0) {
      cacheTotal += total;
      cacheRead += num(tk.cacheRead);
      cacheReqs++;
      if (num(tk.cacheRead) > 0) cacheHitReqs++;
    }
    if (typeof u.cost === 'number' && Number.isFinite(u.cost)) {
      cost += u.cost;
      priced = true;
    }
  }
  const requests = units.length;
  const denom =
    requests - (q.cancelInDenominator ? 0 : cancelled) - (q.includeRejected ? 0 : rejected);
  return {
    key,
    label,
    requests,
    attempts,
    ok,
    failed,
    cancelled,
    cancelBeforeFirst,
    cancelDuring,
    streamBreak,
    fallback,
    burst,
    successRate: rate(ok, denom),
    failureRate: rate(failed, denom),
    cancelRate: rate(cancelled, requests),
    streamBreakRate: rate(streamBreak, committed),
    fallbackRate: rate(fallback, requests),
    cacheHitTokenRate: rate(cacheRead, cacheTotal),
    cacheHitRequestRate: rate(cacheHitReqs, cacheReqs),
    failures,
    ttfb: dist(ttfb),
    ttft: dist(ttft),
    ttftText: dist(ttftText),
    tpot: dist(tpot),
    e2e: dist(e2e),
    outputTps: dist(tps),
    tokens,
    ...(priced ? { cost } : {}),
  };
}

function selected(records: readonly QualityRecord[], q: QualityQuery): Unit[] {
  const countBy = (q.layer ?? 'gateway') === 'gateway' ? (q.countBy ?? 'request') : 'request';
  return unitsOf(inRange(records, q), countBy).filter((u) => matches(u, q.filters));
}

function labelFor(dim: QualityDimension, key: string, labelOf?: QualityLabelOf): string {
  const named = labelOf?.(dim, key);
  if (named) return named;
  return dim === 'key' ? (key.split('\u0000')[1] ?? key) : key;
}

/** 总计 + 按维度分组（+ 上一个等长周期的总计） */
export function queryQuality(
  records: readonly QualityRecord[],
  q: QualityQuery,
  labelOf?: QualityLabelOf,
): QualityResult {
  const units = selected(records, q);
  const total = statsOf(units, '*', '*', q);
  const groups: QualityStats[] = [];
  if (q.groupBy) {
    const by = new Map<string, Unit[]>();
    for (const u of units) {
      const k = dimOf(u, q.groupBy);
      if (k === null) continue;
      const list = by.get(k);
      if (list) list.push(u);
      else by.set(k, [u]);
    }
    for (const [k, list] of by) groups.push(statsOf(list, k, labelFor(q.groupBy, k, labelOf), q));
    groups.sort((a, b) => b.requests - a.requests || a.label.localeCompare(b.label));
  }
  const result: QualityResult = { total, groups, minSamples: MIN_SAMPLES };
  if (q.withPrevious) {
    const span = q.to - q.from;
    result.previous = statsOf(
      selected(records, { ...q, from: q.from - span, to: q.from }),
      '*',
      '*',
      q,
    );
  }
  return result;
}

/** 桶起点（本地时间的整点 / 零点） */
export function bucketStart(ts: number, bucket: 'hour' | 'day'): number {
  const d = new Date(ts);
  if (bucket === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
}

function nextBucket(ts: number, bucket: 'hour' | 'day'): number {
  const d = new Date(ts);
  if (bucket === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
}

function metricOf(s: QualityStats, metric: QualitySeriesQuery['metric']): number | null {
  const dot = metric.indexOf('.');
  if (dot > 0) {
    const d = s[metric.slice(0, dot) as 'ttft' | 'tpot' | 'e2e' | 'outputTps'] as QualityDist;
    const v = d[metric.slice(dot + 1) as 'p50' | 'p90'];
    return typeof v === 'number' ? v : null;
  }
  const v = s[metric as keyof QualityStats];
  return typeof v === 'number' ? v : null;
}

/** 时间序列：按小时 / 天分桶；有 groupBy 时每组一条（按请求数取前 8 组） */
export function seriesQuality(
  records: readonly QualityRecord[],
  q: QualitySeriesQuery,
  labelOf?: QualityLabelOf,
): QualitySeries {
  const buckets: number[] = [];
  for (let b = bucketStart(q.from, q.bucket); b < q.to; b = nextBucket(b, q.bucket))
    buckets.push(b);
  const units = selected(records, q);
  const at = new Map(buckets.map((b, i) => [b, i]));
  const index = (ts: number) => at.get(bucketStart(ts, q.bucket)) ?? -1;
  const groups = new Map<string, Unit[][]>();
  const keyOf = (u: Unit) => (q.groupBy ? dimOf(u, q.groupBy) : '*');
  for (const u of units) {
    const k = keyOf(u);
    if (k === null) continue;
    const i = index(u.r.ts);
    if (i < 0) continue;
    let rows = groups.get(k);
    if (!rows) {
      rows = buckets.map(() => []);
      groups.set(k, rows);
    }
    rows[i]!.push(u);
  }
  const ranked = [...groups.entries()]
    .map(([k, rows]) => ({ k, rows, n: rows.reduce((a, r) => a + r.length, 0) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, q.groupBy ? 8 : 1);
  return {
    buckets,
    series: ranked.map(({ k, rows }) => ({
      key: k,
      label: q.groupBy ? labelFor(q.groupBy, k, labelOf) : '*',
      values: rows.map((list) => (list.length ? metricOf(statsOf(list, k, k, q), q.metric) : null)),
    })),
  };
}

/** 请求明细：筛选后按时间倒序分页 */
export function listRequests(
  records: readonly QualityRecord[],
  q: QualityRequestsQuery,
): { items: QualityRecord[]; total: number } {
  const units = unitsOf(inRange(records, q), 'request').filter((u) => matches(u, q.filters));
  const all = units.map((u) => u.r).sort((a, b) => b.ts - a.ts);
  const offset = Math.max(0, Math.trunc(q.offset ?? 0));
  const limit = Math.min(1000, Math.max(1, Math.trunc(q.limit)));
  return { items: all.slice(offset, offset + limit), total: all.length };
}
