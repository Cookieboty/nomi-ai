/**
 * 模型质量面板：文案、格式化与指标定义（与 docs/design/model-quality.md §2 的口径一致）。
 */
import { t } from '@nomi-ai/ui';

import type {
  QualityDimension,
  QualityDist,
  QualityLayer,
  QualityOutcome,
  QualityStats,
} from '../../services/qualityClient';
import { USAGE_SOURCE_LABEL } from '../../services/usageClient';

/**
 * 多系列配色（按固定顺序取，不循环；最多 4 个，经 dataviz 色盲与对比度校验，见 tokens.css --cd-viz-*）
 */
export const SERIES_COLORS = [
  'var(--cd-viz-1)',
  'var(--cd-viz-2)',
  'var(--cd-viz-3)',
  'var(--cd-viz-4)',
] as const;

/** 少于这么多样本只显示中位数（§2.2） */
export const MIN_SAMPLES = 20;

const WIRE_LABEL: Record<string, string> = {
  messages: 'Messages',
  responses: 'Responses',
  chat: 'Chat',
  gemini: 'Gemini',
};

export const wireLabel = (w: string | undefined): string => (w ? (WIRE_LABEL[w] ?? w) : '—');

export const clientLabel = (c: string): string =>
  c === 'legacy' ? t('旧版令牌') : t(USAGE_SOURCE_LABEL[c] ?? c);

/** 毫秒 → 「850 ms」/「2.4 s」 */
export const formatMs = (ms: number | null | undefined): string =>
  ms == null || !Number.isFinite(ms)
    ? '—'
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/** 0~1 → 百分数（< 10% 保留一位小数） */
export const formatRate = (r: number | null | undefined): string => {
  if (r == null || !Number.isFinite(r)) return '—';
  const p = r * 100;
  return `${p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)}%`;
};

export const formatTps = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)} tok/s`;

/** 模型解析方式（网关按这个顺序：显式 → 档位 → 辅助 → 绑定 → 未知名 → 默认） */
export const resolvedLabel = (r: string): string =>
  ({
    explicit: t('指定的模型'),
    tier: t('档位映射'),
    helper: t('辅助模型'),
    subagent: t('子代理模型'),
    binding: t('标签选的模型'),
    unknown: t('不认识的模型名，用了主模型'),
    default: t('默认模型'),
  })[r] ?? r;

export const outcomeLabel = (o: QualityOutcome): string =>
  ({
    ok: t('成功'),
    'client-cancel': t('取消'),
    auth: t('鉴权失败'),
    'rate-limit': t('限流'),
    'upstream-5xx': t('上游 5xx / 过载'),
    'first-byte-timeout': t('首字超时'),
    'pre-commit-error': t('开始输出前出错'),
    'stream-break': t('断流'),
    'idle-timeout': t('空闲超时'),
    'protocol-violation': t('协议不合规'),
    'repetition-stop': t('复读中止'),
    'request-rejected': t('请求被拒'),
    'gateway-error': t('网关自身错误'),
    'cli-error': t('CLI 报错'),
    'cli-exit': t('CLI 中途退出'),
  })[o];

/** 结果对应的徽标色调（状态色带文字，不单靠颜色） */
export const outcomeTone = (o: QualityOutcome): 'success' | 'warning' | 'danger' | 'neutral' =>
  o === 'ok'
    ? 'success'
    : o === 'client-cancel'
      ? 'neutral'
      : o === 'rate-limit' || o === 'request-rejected'
        ? 'warning'
        : 'danger';

export const sourceLabel = (s: string): string =>
  ({ nomi: t('Nomi 对话'), official: t('官方账号'), thirdParty: t('第三方供应商') })[s] ?? s;

export const layerLabel = (l: QualityLayer): string =>
  l === 'gateway' ? t('网关层') : t('CLI 层');

export const DIMENSIONS: Array<{ value: QualityDimension; label: string; gatewayOnly?: boolean }> =
  [
    { value: 'provider', label: '供应商' },
    { value: 'key', label: 'Key', gatewayOnly: true },
    { value: 'model', label: '模型' },
    { value: 'modelFamily', label: '模型族' },
    { value: 'client', label: '客户端' },
    { value: 'source', label: '来源' },
    { value: 'protocol', label: '协议', gatewayOnly: true },
    { value: 'resolved', label: '模型解析方式', gatewayOnly: true },
  ];

export const dimensionLabel = (d: QualityDimension): string =>
  t(DIMENSIONS.find((x) => x.value === d)?.label ?? (d === 'outcome' ? '结果' : d));

/** 分组键 → 显示名（分组结果自带 label，这里兜底并本地化少数固定值） */
export const groupLabel = (d: QualityDimension | undefined, s: QualityStats): string => {
  if (d === 'client') return clientLabel(s.key);
  if (d === 'source') return sourceLabel(s.key);
  if (d === 'resolved') return resolvedLabel(s.key);
  if (d === 'outcome') return outcomeLabel(s.key as QualityOutcome);
  return s.label || s.key;
};

type DistKey = 'ttfb' | 'ttft' | 'ttftText' | 'tpot' | 'e2e' | 'outputTps';
type Pct = 'p50' | 'p90' | 'p99';

export interface MetricDef {
  id: string;
  /** 列标题（i18n key） */
  label: string;
  /** 说明（列标题的提示） */
  hint?: string;
  group: 'rate' | 'latency' | 'speed' | 'cache' | 'volume';
  /** 越大越好（排序与升降箭头的语义） */
  higherIsBetter: boolean;
  /** 取值；null = 没有数据 */
  value: (s: QualityStats) => number | null;
  format: (v: number | null) => string;
  /** 分布类指标：样本数（用于样本不足判断） */
  dist?: (s: QualityStats) => QualityDist;
  /** 只在网关层有 */
  gatewayOnly?: boolean;
}

const num = (v: number | undefined | null): number | null =>
  v == null || !Number.isFinite(v) ? null : v;

const rate = (
  id: string,
  label: string,
  pick: (s: QualityStats) => number | undefined,
  higherIsBetter: boolean,
  hint?: string,
): MetricDef => ({
  id,
  label,
  hint,
  group: 'rate',
  higherIsBetter,
  value: (s) => num(pick(s)),
  format: formatRate,
});

const dist = (
  key: DistKey,
  pct: Pct,
  label: string,
  opts: { gatewayOnly?: boolean; speed?: boolean; hint?: string } = {},
): MetricDef => ({
  id: `${key}.${pct}`,
  label,
  hint: opts.hint,
  group: opts.speed ? 'speed' : 'latency',
  higherIsBetter: !!opts.speed,
  value: (s) => num(s[key][pct]),
  format: opts.speed ? formatTps : formatMs,
  dist: (s) => s[key],
  gatewayOnly: opts.gatewayOnly,
});

const BURST_HINT = '上游缓冲后整段吐出，TPOT / tok/s 不计入';

/** 对比表可选的指标列（顺序即默认列顺序） */
export const METRICS: MetricDef[] = [
  {
    id: 'requests',
    label: '请求数',
    group: 'volume',
    higherIsBetter: true,
    value: (s) => s.requests,
    format: (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US')),
  },
  rate('successRate', '成功率', (s) => s.successRate, true),
  rate('failureRate', '失败率', (s) => s.failureRate, false),
  rate('cancelRate', '取消率', (s) => s.cancelRate, false),
  rate('streamBreakRate', '断流率', (s) => s.streamBreakRate, false),
  rate('fallbackRate', '回退率', (s) => s.fallbackRate, false),
  dist('ttfb', 'p50', 'TTFB p50', { gatewayOnly: true, hint: '收到上游响应头的时间' }),
  dist('ttft', 'p50', 'TTFT p50', { hint: '第一个内容（正文 / 推理 / 工具参数）的时间' }),
  dist('ttft', 'p90', 'TTFT p90'),
  dist('ttft', 'p99', 'TTFT p99'),
  dist('tpot', 'p50', 'TPOT p50', { hint: `每个输出 token 的间隔；${BURST_HINT}` }),
  dist('tpot', 'p90', 'TPOT p90'),
  dist('e2e', 'p50', 'E2E p50', { hint: '从发出到结束的总耗时' }),
  dist('e2e', 'p90', 'E2E p90'),
  dist('e2e', 'p99', 'E2E p99'),
  dist('outputTps', 'p50', '输出速度 p50', { speed: true, hint: BURST_HINT }),
  {
    id: 'cacheHitTokenRate',
    label: '缓存命中（token）',
    hint: '缓存读 ÷ 输入总量',
    group: 'cache',
    higherIsBetter: true,
    value: (s) => num(s.cacheHitTokenRate),
    format: formatRate,
  },
  {
    id: 'cacheHitRequestRate',
    label: '缓存命中（请求）',
    hint: '有缓存读的请求 ÷ 请求数',
    group: 'cache',
    higherIsBetter: true,
    value: (s) => num(s.cacheHitRequestRate),
    format: formatRate,
  },
  {
    id: 'outputTokens',
    label: '输出 token',
    group: 'volume',
    higherIsBetter: true,
    value: (s) => s.tokens.output,
    format: (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US')),
  },
  {
    id: 'burst',
    label: '整段吐出',
    hint: BURST_HINT,
    group: 'volume',
    higherIsBetter: false,
    value: (s) => s.burst,
    format: (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US')),
  },
];

export const DEFAULT_COLUMNS = [
  'requests',
  'successRate',
  'failureRate',
  'streamBreakRate',
  'ttft.p50',
  'tpot.p50',
  'e2e.p50',
  'outputTps.p50',
  'cacheHitTokenRate',
];

export const metricById = (id: string): MetricDef | undefined => METRICS.find((m) => m.id === id);

/**
 * 分布类指标在样本不足时只给中位数（p90 / p99 / 平均值没有意义）：
 * 返回 null 表示这一格应显示「样本不足」。
 */
export function guardedValue(m: MetricDef, s: QualityStats): number | null {
  const v = m.value(s);
  if (!m.dist) return v;
  const d = m.dist(s);
  if (d.n < MIN_SAMPLES && !m.id.endsWith('.p50')) return null;
  return v;
}

export const isSmallSample = (m: MetricDef, s: QualityStats): boolean =>
  !!m.dist && m.dist(s).n < MIN_SAMPLES;

/**
 * 与上一周期比：返回带方向的变化（正 = 变好）与显示文本；任一边没有数据返回 null。
 * 比率类按百分点，其余按相对变化。
 */
export function changeOf(
  m: MetricDef,
  cur: number | null,
  prev: number | null,
): { better: boolean; worse: boolean; text: string } | null {
  if (cur == null || prev == null) return null;
  const isRate = m.group === 'rate' || m.group === 'cache';
  const diff = cur - prev;
  if (isRate) {
    const pp = diff * 100;
    if (Math.abs(pp) < 0.05) return { better: false, worse: false, text: '±0' };
    const better = m.higherIsBetter ? pp > 0 : pp < 0;
    return { better, worse: !better, text: `${pp > 0 ? '+' : ''}${pp.toFixed(1)} pp` };
  }
  if (prev === 0) return null;
  const rel = (diff / prev) * 100;
  if (Math.abs(rel) < 0.5) return { better: false, worse: false, text: '±0%' };
  const better = m.higherIsBetter ? rel > 0 : rel < 0;
  return { better, worse: !better, text: `${rel > 0 ? '+' : ''}${Math.round(rel)}%` };
}

/** 时间范围预设 */
export type RangeId = 'today' | '7d' | '30d' | 'custom';

export function rangeOf(
  id: RangeId,
  now: number,
  custom?: { from: number; to: number },
): { from: number; to: number } {
  if (id === 'custom' && custom) return custom;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const today = d.getTime();
  if (id === 'today') return { from: today, to: now };
  const days = id === '30d' ? 30 : 7;
  return { from: today - (days - 1) * 86_400_000, to: now };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** epoch ms → yyyy-mm-dd（日期输入框用） */
export const toDateInput = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** yyyy-mm-dd → 当天 0 点 / 23:59:59.999 的 epoch ms */
export const fromDateInput = (v: string, end = false): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (end) d.setHours(23, 59, 59, 999);
  return d.getTime();
};
