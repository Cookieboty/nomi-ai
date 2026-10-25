/**
 * 模型质量面板：文案、格式化、层级预设与对比表的列（与 docs/design/model-quality.md §2 的口径一致）。
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
  c === 'legacy' ? t('ui.usage-tools.legacy-token') : t(USAGE_SOURCE_LABEL[c] ?? c);

/** 毫秒 → 「850 ms」/「2.4 s」 */
export const formatMs = (ms: number | null | undefined): string =>
  ms == null || !Number.isFinite(ms)
    ? '—'
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/** 0~1 → 百分数（< 10% 保留一位小数）：趋势图、上一周期对比用 */
export const formatRate = (r: number | null | undefined): string => {
  if (r == null || !Number.isFinite(r)) return '—';
  const p = r * 100;
  return `${p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)}%`;
};

/** 0~1 → 两位小数的百分数（对比表：98.45%） */
export const formatPct = (r: number | null | undefined): string =>
  r == null || !Number.isFinite(r) ? '—' : `${(r * 100).toFixed(2)}%`;

const trim = (s: string) => s.replace(/\.?0+$/, '');

/** 计数 / token 数：1234 → 1.23K，78080 → 78.08K，2.5e6 → 2.5M */
export const formatCount = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a < 1000) return String(Math.round(v));
  if (a < 1_000_000) return `${trim((v / 1000).toFixed(2))}K`;
  if (a < 1_000_000_000) return `${trim((v / 1_000_000).toFixed(2))}M`;
  return `${trim((v / 1_000_000_000).toFixed(2))}B`;
};

export const formatTps = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)} tok/s`;

/** 模型解析方式（网关按这个顺序：显式 → 档位 → 辅助 → 绑定 → 未知名 → 默认） */
export const resolvedLabel = (r: string): string =>
  ({
    explicit: t('ui.usage-tools.requested-model'),
    tier: t('ui.usage-tools.tier-mapping'),
    helper: t('ui.usage-tools.helper-model'),
    subagent: t('ui.usage-tools.subagent-model'),
    binding: t('ui.usage-tools.tab-s-model'),
    unknown: t('ui.usage-tools.unknown-model-name-used-the-main-model'),
    default: t('ui.providers-schedule.default-model'),
  })[r] ?? r;

export const outcomeLabel = (o: QualityOutcome): string =>
  ({
    ok: t('ui.model-quality.success'),
    'client-cancel': t('ui.foundation.cancel'),
    auth: t('ui.model-quality.auth-failed'),
    'rate-limit': t('ui.model-quality.rate-limited'),
    'upstream-5xx': t('ui.model-quality.upstream-5xx-overloaded'),
    'first-byte-timeout': t('ui.model-quality.first-byte-timeout'),
    'pre-commit-error': t('ui.model-quality.error-before-output'),
    'stream-break': t('ui.model-quality.stream-break'),
    'idle-timeout': t('ui.model-quality.idle-timeout'),
    'protocol-violation': t('ui.model-quality.protocol-violation'),
    'repetition-stop': t('ui.model-quality.stopped-for-repetition'),
    'request-rejected': t('ui.model-quality.request-rejected'),
    'gateway-error': t('ui.model-quality.gateway-error'),
    'cli-error': t('ui.model-quality.cli-error'),
    'cli-exit': t('ui.model-quality.cli-exited-mid-turn'),
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
  ({
    nomi: t('ui.usage-tools.nomi-chat'),
    official: t('ui.chat-settings.official-accounts'),
    thirdParty: t('ui.models.third-party-providers'),
  })[s] ?? s;

export const layerLabel = (l: QualityLayer): string =>
  l === 'gateway' ? t('ui.model-quality.gateway-layer') : t('ui.model-quality.cli-layer');

export const dimensionLabel = (d: QualityDimension): string =>
  ({
    provider: t('ui.providers-schedule.provider'),
    key: 'Key',
    model: t('ui.foundation.model'),
    modelFamily: t('ui.foundation.model'),
    client: t('ui.model-quality.client'),
    source: t('ui.knowledge-local.sources'),
    protocol: t('ui.model-quality.protocol'),
    resolved: t('ui.model-quality.model-resolution'),
    outcome: t('ui.foundation.result'),
    routeQuality: t('ui.model-quality.routing-quality'),
    loss: t('ui.model-quality.primary-loss'),
  })[d];

/** 所有结果类别（顺序即筛选菜单顺序） */
export const OUTCOMES: QualityOutcome[] = [
  'ok',
  'client-cancel',
  'auth',
  'rate-limit',
  'upstream-5xx',
  'first-byte-timeout',
  'pre-commit-error',
  'stream-break',
  'idle-timeout',
  'protocol-violation',
  'repetition-stop',
  'request-rejected',
  'gateway-error',
  'cli-error',
  'cli-exit',
];

/** 「失败」列钻取：不含成功、取消与客户端错误 */
export const FAILURE_OUTCOMES = OUTCOMES.filter(
  (o) => o !== 'ok' && o !== 'client-cancel' && o !== 'request-rejected',
);
/** 「流中断」列钻取 */
export const BREAK_OUTCOMES: QualityOutcome[] = ['stream-break', 'idle-timeout', 'cli-exit'];

/** 厂商名 → 品牌图标 id（packages/ui brand/icons.ts） */
const VENDOR_BRAND: Record<string, string> = {
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  Google: 'gemini',
  DeepSeek: 'deepseek',
  'Z.ai': 'zhipu',
  xAI: 'xai',
  Moonshot: 'kimi',
  Qwen: 'qwen',
  MiniMax: 'minimax',
  ByteDance: 'doubao',
};
export const brandOfVendor = (v: string | undefined): string | undefined =>
  v ? VENDOR_BRAND[v] : undefined;

/** 一行的显示名：模型「厂商: 模型」，客户端 / 来源本地化，其余用聚合给的名字 */
export const rowLabel = (s: QualityStats): string => {
  if (s.dim === 'modelFamily' || s.dim === 'model') {
    const name = s.display ?? s.label;
    return s.vendor ? `${s.vendor}: ${name}` : name;
  }
  if (s.dim === 'client') return clientLabel(s.key);
  if (s.dim === 'source') return sourceLabel(s.key);
  if (s.dim === 'resolved') return resolvedLabel(s.key);
  if (s.dim === 'outcome') return outcomeLabel(s.key as QualityOutcome);
  return s.label || s.key;
};

/* --------------------------------- 层级预设 --------------------------------- */

export type HierarchyId =
  'model-provider-key' | 'model-client-provider' | 'client-model-provider' | 'provider-model';

export const HIERARCHIES: Array<{
  id: HierarchyId;
  gateway: QualityDimension[];
  cli: QualityDimension[];
}> = [
  {
    id: 'model-provider-key',
    gateway: ['modelFamily', 'provider', 'key'],
    // CLI 层没有 Key
    cli: ['modelFamily', 'provider'],
  },
  {
    id: 'model-client-provider',
    gateway: ['modelFamily', 'client', 'provider'],
    cli: ['modelFamily', 'client', 'provider'],
  },
  {
    id: 'client-model-provider',
    gateway: ['client', 'modelFamily', 'provider'],
    cli: ['client', 'modelFamily', 'provider'],
  },
  { id: 'provider-model', gateway: ['provider', 'modelFamily'], cli: ['provider', 'modelFamily'] },
];

export const hierarchyPath = (id: HierarchyId, layer: QualityLayer): QualityDimension[] => {
  const h = HIERARCHIES.find((x) => x.id === id) ?? HIERARCHIES[0]!;
  return layer === 'gateway' ? h.gateway : h.cli;
};

export const hierarchyLabel = (id: HierarchyId, layer: QualityLayer): string =>
  hierarchyPath(id, layer)
    .map((d) => dimensionLabel(d))
    .join(' → ');

/* --------------------------------- 对比表的列 --------------------------------- */

export type ColumnGroup = 'count' | 'token' | 'latency' | 'speed';

export interface Column {
  id: string;
  group: ColumnGroup;
  /** 分组表头下的子表头（P50 / P95 / P99）；没有就是独立列 */
  sub?: string;
  /** 独立列的表头 */
  label?: string;
  hint?: string;
  value: (s: QualityStats) => number | null;
  format: (v: number | null) => string;
  /** 文字高亮（状态色，带文字说明） */
  tone?: (s: QualityStats, v: number | null) => 'danger' | 'warning' | 'success' | undefined;
  /** 点击钻取到请求明细时带的结果筛选；'all' = 不限结果 */
  drill?: QualityOutcome[] | 'all';
  /** 分布列：样本数（不足 20 时只显示 P50） */
  dist?: (s: QualityStats) => QualityDist;
}

const n = (v: number | undefined | null): number | null =>
  v == null || !Number.isFinite(v) ? null : v;

const pct3 = (
  group: ColumnGroup,
  key: 'inputLen' | 'ttft' | 'e2e',
  format: (v: number | null) => string,
): Column[] =>
  (['p50', 'p95', 'p99'] as const).map((p) => ({
    id: `${key}.${p}`,
    group,
    sub: p.toUpperCase(),
    value: (s: QualityStats) => n(s[key]?.[p]),
    format,
    dist: (s: QualityStats) => s[key] ?? { n: 0 },
  }));

/** 分组表头（按出现顺序） */
export const GROUP_HEADS: Array<{ id: string; label: string; hint: string; group: ColumnGroup }> = [
  {
    id: 'ttft',
    label: 'ui.model-quality.first-token-ttft',
    hint: 'ui.model-quality.from-send-to-the-first-content-text-reasoning',
    group: 'latency',
  },
  {
    id: 'e2e',
    label: 'ui.model-quality.duration-e2e',
    hint: 'ui.model-quality.total-time-from-send-to-finish',
    group: 'latency',
  },
  {
    id: 'speed',
    label: 'ui.model-quality.speed',
    hint: 'ui.model-quality.buffered-all-at-once-responses-are-excluded',
    group: 'speed',
  },
  {
    id: 'inputLen',
    label: 'ui.model-quality.input-length',
    hint: 'ui.model-quality.input-tokens-per-request-including-cache-reads-and',
    group: 'token',
  },
];

export const COLUMNS: Column[] = [
  {
    id: 'ok',
    group: 'count',
    label: 'ui.model-quality.success',
    hint: 'ui.model-quality.completed-normally-by-attempt-a-request-that-falls',
    value: (s) => s.ok,
    format: formatCount,
    drill: ['ok'],
  },
  {
    id: 'failed',
    group: 'count',
    label: 'ui.foundation.failed',
    hint: 'ui.model-quality.auth-rate-limits-upstream-5xx-timeouts-stream-breaks',
    value: (s) => s.failed,
    format: formatCount,
    tone: (_s, v) => (v ? 'danger' : undefined),
    drill: FAILURE_OUTCOMES,
  },
  {
    id: 'clientErrors',
    group: 'count',
    label: 'ui.model-quality.client-errors',
    hint: 'ui.model-quality.problems-with-the-request-itself-400-404-413',
    value: (s) => s.clientErrors,
    format: formatCount,
    drill: ['request-rejected'],
  },
  {
    id: 'total',
    group: 'count',
    label: 'ui.model-quality.total',
    hint: 'ui.model-quality.success-failed-client-errors-cancelled',
    value: (s) => s.total,
    format: formatCount,
    drill: 'all',
  },
  {
    id: 'successRate',
    group: 'count',
    label: 'ui.model-quality.success-rate',
    hint: 'ui.model-quality.success-total-cancelled-client-errors-red-below-95',
    value: (s) => n(s.successRate),
    format: formatPct,
    tone: (_s, v) =>
      v == null ? undefined : v < 0.95 ? 'danger' : v >= 0.995 ? 'success' : undefined,
  },
  {
    id: 'cacheHit',
    group: 'count',
    label: 'ui.model-quality.cache-hit',
    hint: 'ui.model-quality.cache-reads-total-input-by-token',
    value: (s) => n(s.cacheHitTokenRate),
    format: formatPct,
  },
  {
    id: 'cancelled',
    group: 'count',
    label: 'ui.foundation.cancelled',
    hint: 'ui.model-quality.requests-you-or-the-coding-agent-stopped-before',
    value: (s) => s.cancelled,
    format: formatCount,
    drill: ['client-cancel'],
  },
  {
    id: 'streamBreak',
    group: 'count',
    label: 'ui.model-quality.stream-breaks',
    hint: 'ui.model-quality.started-output-but-didn-t-finish-normally-stream',
    value: (s) => s.streamBreak,
    format: formatCount,
    tone: (_s, v) => (v ? 'warning' : undefined),
    drill: BREAK_OUTCOMES,
  },
  ...pct3('latency', 'ttft', formatMs),
  ...pct3('latency', 'e2e', formatMs),
  {
    id: 'outputTps.p50',
    group: 'speed',
    sub: 'tok/s',
    hint: 'ui.model-quality.median-of-output-tokens-generation-time',
    value: (s) => n(s.outputTps?.p50),
    format: (v) => (v == null ? '—' : String(v < 10 ? v.toFixed(1) : Math.round(v))),
    dist: (s) => s.outputTps,
  },
  {
    id: 'tpot.p50',
    group: 'speed',
    sub: 'TPOT',
    hint: 'ui.model-quality.median-interval-between-output-tokens',
    value: (s) => n(s.tpot?.p50),
    format: formatMs,
    dist: (s) => s.tpot,
  },
  ...pct3('token', 'inputLen', formatCount),
];

/** 分布列在样本不足时只给中位数（P95 / P99 没有意义）：返回 null 表示「样本不足」 */
export function cellValue(c: Column, s: QualityStats): number | null {
  const v = c.value(s);
  if (!c.dist || c.id.endsWith('.p50') || !c.id.includes('.p')) return v;
  return c.dist(s).n < MIN_SAMPLES ? null : v;
}

/* --------------------------------- 与上一周期比 --------------------------------- */

/**
 * 返回带方向的变化（正 = 变好）与显示文本；任一边没有数据返回 null。比率类按百分点，其余按相对变化。
 */
export function changeOf(
  m: { higherIsBetter: boolean; rate: boolean },
  cur: number | null,
  prev: number | null,
): { better: boolean; worse: boolean; text: string } | null {
  if (cur == null || prev == null) return null;
  const diff = cur - prev;
  if (m.rate) {
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

/* --------------------------------- 时间范围 --------------------------------- */

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

const pad = (x: number) => String(x).padStart(2, '0');

/** epoch ms → yyyy-mm-dd（日期输入框用） */
export const toDateInput = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** epoch ms → 10/24 16:30（统计区间） */
export const formatStamp = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** epoch ms → 10/24（区间芯片） */
export const formatDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/** yyyy-mm-dd → 当天 0 点 / 23:59:59.999 的 epoch ms */
export const fromDateInput = (v: string, end = false): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (end) d.setHours(23, 59, 59, 999);
  return d.getTime();
};
