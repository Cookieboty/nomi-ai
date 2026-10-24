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
  c === 'legacy' ? t('旧版令牌') : t(USAGE_SOURCE_LABEL[c] ?? c);

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

export const dimensionLabel = (d: QualityDimension): string =>
  ({
    provider: t('供应商'),
    key: 'Key',
    model: t('模型'),
    modelFamily: t('模型'),
    client: t('客户端'),
    source: t('来源'),
    protocol: t('协议'),
    resolved: t('模型解析方式'),
    outcome: t('结果'),
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
    label: '首字（TTFT）',
    hint: '从发出到第一个内容（正文 / 推理 / 工具参数）',
    group: 'latency',
  },
  { id: 'e2e', label: '耗时（E2E）', hint: '从发出到结束的总耗时', group: 'latency' },
  { id: 'speed', label: '速度', hint: '整段吐出的请求不计入', group: 'speed' },
  { id: 'inputLen', label: '输入长度', hint: '每次请求的输入 token（含缓存读写）', group: 'token' },
];

export const COLUMNS: Column[] = [
  {
    id: 'ok',
    group: 'count',
    label: '成功',
    hint: '正常结束的次数（按尝试计时：一次请求回退到多个候选计多次）',
    value: (s) => s.ok,
    format: formatCount,
    drill: ['ok'],
  },
  {
    id: 'failed',
    group: 'count',
    label: '失败',
    hint: '鉴权、限流、上游 5xx、超时、断流等；不含客户端错误',
    value: (s) => s.failed,
    format: formatCount,
    tone: (_s, v) => (v ? 'danger' : undefined),
    drill: FAILURE_OUTCOMES,
  },
  {
    id: 'clientErrors',
    group: 'count',
    label: '客户端错误',
    hint: '请求本身的问题：400 / 404 / 413 / 上下文超长等，默认不算供应商失败',
    value: (s) => s.clientErrors,
    format: formatCount,
    drill: ['request-rejected'],
  },
  {
    id: 'total',
    group: 'count',
    label: '总数',
    hint: '成功 + 失败 + 客户端错误 + 取消',
    value: (s) => s.total,
    format: formatCount,
    drill: 'all',
  },
  {
    id: 'successRate',
    group: 'count',
    label: '成功率',
    hint: '成功 ÷（总数 − 取消 − 客户端错误）；低于 95% 标红，99.5% 以上标绿',
    value: (s) => n(s.successRate),
    format: formatPct,
    tone: (_s, v) =>
      v == null ? undefined : v < 0.95 ? 'danger' : v >= 0.995 ? 'success' : undefined,
  },
  {
    id: 'cacheHit',
    group: 'count',
    label: '缓存命中',
    hint: '缓存读 ÷ 输入总量（按 token）',
    value: (s) => n(s.cacheHitTokenRate),
    format: formatPct,
  },
  {
    id: 'cancelled',
    group: 'count',
    label: '已取消',
    hint: '你或编程助手在结束前停止的请求',
    value: (s) => s.cancelled,
    format: formatCount,
    drill: ['client-cancel'],
  },
  {
    id: 'streamBreak',
    group: 'count',
    label: '流中断',
    hint: '开始输出后没有正常结束（断流、空闲超时、CLI 中途退出）',
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
    hint: '输出 token ÷ 生成时长的中位数',
    value: (s) => n(s.outputTps?.p50),
    format: (v) => (v == null ? '—' : String(v < 10 ? v.toFixed(1) : Math.round(v))),
    dist: (s) => s.outputTps,
  },
  {
    id: 'tpot.p50',
    group: 'speed',
    sub: 'TPOT',
    hint: '相邻输出 token 的间隔中位数',
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
