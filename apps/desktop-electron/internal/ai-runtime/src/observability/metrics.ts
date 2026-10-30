/**
 * ai-runtime · metrics registry（P9-2 · Polish C）
 *
 * 目标：给 [AIClient](file:///../../../ai-sdk/src/AIClient.ts) 与 插件宿主 Waterfall hook
 * 提供一个**零依赖**的进程内 metrics 采集器，覆盖 P9 计划 §P9-2 列出的 8 个内置指标：
 * - `ai.chat.tokens.prompt` (Counter · provider/model)
 * - `ai.chat.tokens.completion` (Counter · provider/model)
 * - `ai.chat.latency.ttfb` (Histogram · provider/model)
 * - `ai.tool.exec.duration` (Histogram · tool)
 * - `ai.tool.error.count` (Counter · tool/code)
 * - `ai.tts.latency.first_chunk` (Histogram · provider)
 * - `ai.asr.latency.final` (Histogram · provider)
 * - `ai.agent.steps.per_turn` (Histogram)
 *
 * 设计要点：
 * - **零依赖**：不引 prom-client / OpenTelemetry SDK；仅暴露纯函数 API + snapshot，
 *   便于 UI（ai-chat/Diagnostics）与 CI 断言消费；
 * - **Prometheus text 兼容**：`toPrometheus()` 输出符合
 *   [text exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/)
 *   的字符串，供后续 `GET /metrics` HTTP 端点直接返回；
 * - **Histogram** 内部维护 fixed buckets + `_sum` / `_count`，与 prom-client 一致；
 * - **标签值兜底**：`undefined / null` 一律转成字面量 `_`（Prometheus 不允许缺失 label）；
 * - **进程隔离**：默认导出 `defaultRegistry` 单例，但允许业务方 `new MetricsRegistry()`
 *   建立独立命名空间（多 profile / 测试隔离）。
 */

export type MetricKind = 'counter' | 'histogram' | 'gauge';

export type LabelValues = Readonly<Record<string, string | number | boolean | undefined>>;

const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;

/** 默认 histogram bucket（毫秒 / token 数通用）。 */
export const DEFAULT_LATENCY_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
] as const;

/** token 数场景常用 bucket。 */
export const DEFAULT_TOKEN_BUCKETS = [1, 10, 50, 100, 500, 1000, 4000, 16000, 64000] as const;

export interface MetricDescriptor {
  name: string;
  help: string;
  labelNames?: readonly string[];
  buckets?: readonly number[];
}

interface CounterState {
  kind: 'counter';
  desc: MetricDescriptor;
  /** key -> { labels, value } */
  series: Map<string, { labels: LabelValues; value: number }>;
}

interface GaugeState {
  kind: 'gauge';
  desc: MetricDescriptor;
  series: Map<string, { labels: LabelValues; value: number }>;
}

interface HistogramState {
  kind: 'histogram';
  desc: MetricDescriptor;
  buckets: readonly number[];
  series: Map<
    string,
    {
      labels: LabelValues;
      bucketCounts: number[]; // 与 buckets 等长；bucketCounts[i] = 落在 (<= buckets[i]) 的次数
      sum: number;
      count: number;
    }
  >;
}

type MetricState = CounterState | HistogramState | GaugeState;

export interface CounterSnapshot {
  kind: 'counter';
  name: string;
  help: string;
  values: Array<{ labels: Record<string, string>; value: number }>;
}

export interface GaugeSnapshot {
  kind: 'gauge';
  name: string;
  help: string;
  values: Array<{ labels: Record<string, string>; value: number }>;
}

export interface HistogramSnapshot {
  kind: 'histogram';
  name: string;
  help: string;
  buckets: readonly number[];
  values: Array<{
    labels: Record<string, string>;
    bucketCounts: number[];
    sum: number;
    count: number;
  }>;
}

export type MetricSnapshot = CounterSnapshot | GaugeSnapshot | HistogramSnapshot;

export interface Counter {
  readonly name: string;
  inc(labels?: LabelValues, delta?: number): void;
}

export interface Gauge {
  readonly name: string;
  set(value: number, labels?: LabelValues): void;
  inc(labels?: LabelValues, delta?: number): void;
  dec(labels?: LabelValues, delta?: number): void;
}

export interface Histogram {
  readonly name: string;
  readonly buckets: readonly number[];
  observe(value: number, labels?: LabelValues): void;
  /** 便捷计时器：调用返回的 `end()` 完成一次 observe（毫秒）。 */
  startTimer(labels?: LabelValues): () => number;
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, MetricState>();

  createCounter(desc: MetricDescriptor): Counter {
    const state = this.ensure(desc, 'counter') as CounterState;
    return {
      name: state.desc.name,
      inc: (labels, delta = 1) => {
        if (!Number.isFinite(delta)) return;
        const norm = normalizeLabels(state.desc.labelNames, labels);
        const key = labelKey(norm);
        const bucket = state.series.get(key);
        if (bucket) {
          bucket.value += delta;
        } else {
          state.series.set(key, { labels: norm, value: delta });
        }
      },
    };
  }

  createGauge(desc: MetricDescriptor): Gauge {
    const state = this.ensure(desc, 'gauge') as GaugeState;
    const upsert = (labels: LabelValues | undefined, mutate: (prev: number) => number): void => {
      const norm = normalizeLabels(state.desc.labelNames, labels);
      const key = labelKey(norm);
      const prev = state.series.get(key)?.value ?? 0;
      state.series.set(key, { labels: norm, value: mutate(prev) });
    };
    return {
      name: state.desc.name,
      set: (value, labels) => {
        if (!Number.isFinite(value)) return;
        upsert(labels, () => value);
      },
      inc: (labels, delta = 1) => {
        if (!Number.isFinite(delta)) return;
        upsert(labels, (prev) => prev + delta);
      },
      dec: (labels, delta = 1) => {
        if (!Number.isFinite(delta)) return;
        upsert(labels, (prev) => prev - delta);
      },
    };
  }

  createHistogram(desc: MetricDescriptor): Histogram {
    const state = this.ensure(desc, 'histogram') as HistogramState;
    return {
      name: state.desc.name,
      buckets: state.buckets,
      observe: (value, labels) => this.observeHistogram(state, value, labels),
      startTimer: (labels) => {
        const start = now();
        return () => {
          const elapsed = now() - start;
          this.observeHistogram(state, elapsed, labels);
          return elapsed;
        };
      },
    };
  }

  /** 快照当前所有 metric 状态；测试与 UI 消费。 */
  snapshot(): MetricSnapshot[] {
    const out: MetricSnapshot[] = [];
    for (const state of this.metrics.values()) {
      if (state.kind === 'counter') {
        out.push({
          kind: 'counter',
          name: state.desc.name,
          help: state.desc.help,
          values: [...state.series.values()].map((s) => ({
            labels: stringifyLabels(s.labels),
            value: s.value,
          })),
        });
      } else if (state.kind === 'gauge') {
        out.push({
          kind: 'gauge',
          name: state.desc.name,
          help: state.desc.help,
          values: [...state.series.values()].map((s) => ({
            labels: stringifyLabels(s.labels),
            value: s.value,
          })),
        });
      } else {
        out.push({
          kind: 'histogram',
          name: state.desc.name,
          help: state.desc.help,
          buckets: state.buckets,
          values: [...state.series.values()].map((s) => ({
            labels: stringifyLabels(s.labels),
            bucketCounts: [...s.bucketCounts],
            sum: s.sum,
            count: s.count,
          })),
        });
      }
    }
    return out;
  }

  /** 生成 Prometheus text exposition 格式。空 registry 返回空字符串。 */
  toPrometheus(): string {
    const lines: string[] = [];
    for (const state of this.metrics.values()) {
      lines.push(`# HELP ${state.desc.name} ${escapeHelp(state.desc.help)}`);
      lines.push(`# TYPE ${state.desc.name} ${state.kind}`);
      if (state.kind === 'counter' || state.kind === 'gauge') {
        for (const s of state.series.values()) {
          lines.push(`${state.desc.name}${renderLabels(s.labels)} ${formatNumber(s.value)}`);
        }
      } else {
        for (const s of state.series.values()) {
          for (let i = 0; i < state.buckets.length; i++) {
            const le = state.buckets[i]!;
            const labels = { ...s.labels, le: String(le) };
            lines.push(`${state.desc.name}_bucket${renderLabels(labels)} ${s.bucketCounts[i]}`);
          }
          const infLabels = { ...s.labels, le: '+Inf' };
          lines.push(`${state.desc.name}_bucket${renderLabels(infLabels)} ${s.count}`);
          lines.push(`${state.desc.name}_sum${renderLabels(s.labels)} ${formatNumber(s.sum)}`);
          lines.push(`${state.desc.name}_count${renderLabels(s.labels)} ${s.count}`);
        }
      }
    }
    if (lines.length === 0) return '';
    return `${lines.join('\n')}\n`;
  }

  /** 重置所有 series（保留 descriptor）；仅测试使用。 */
  reset(): void {
    for (const state of this.metrics.values()) state.series.clear();
  }

  /** 完全清空（连 descriptor 一起丢弃）。 */
  clear(): void {
    this.metrics.clear();
  }

  private ensure(desc: MetricDescriptor, kind: MetricKind): MetricState {
    const existed = this.metrics.get(desc.name);
    if (existed) {
      if (existed.kind !== kind) {
        throw new Error(
          `[ai-runtime] metric '${desc.name}' already registered as ${existed.kind}, cannot re-register as ${kind}`,
        );
      }
      return existed;
    }
    if (kind === 'counter') {
      const state: CounterState = { kind: 'counter', desc, series: new Map() };
      this.metrics.set(desc.name, state);
      return state;
    }
    if (kind === 'gauge') {
      const state: GaugeState = { kind: 'gauge', desc, series: new Map() };
      this.metrics.set(desc.name, state);
      return state;
    }
    const buckets = normalizeBuckets(desc.buckets ?? DEFAULT_LATENCY_BUCKETS_MS);
    const state: HistogramState = { kind: 'histogram', desc, buckets, series: new Map() };
    this.metrics.set(desc.name, state);
    return state;
  }

  private observeHistogram(
    state: HistogramState,
    value: number,
    labels: LabelValues | undefined,
  ): void {
    if (!Number.isFinite(value)) return;
    const norm = normalizeLabels(state.desc.labelNames, labels);
    const key = labelKey(norm);
    let bucket = state.series.get(key);
    if (!bucket) {
      bucket = {
        labels: norm,
        bucketCounts: new Array(state.buckets.length).fill(0) as number[],
        sum: 0,
        count: 0,
      };
      state.series.set(key, bucket);
    }
    bucket.sum += value;
    bucket.count += 1;
    for (let i = 0; i < state.buckets.length; i++) {
      if (value <= state.buckets[i]!) bucket.bucketCounts[i]! += 1;
    }
  }
}

function normalizeBuckets(input: readonly number[]): readonly number[] {
  const cleaned = Array.from(new Set(input.filter((n) => Number.isFinite(n)))).sort(
    (a, b) => a - b,
  );
  if (cleaned.length === 0) return [...DEFAULT_LATENCY_BUCKETS_MS];
  return cleaned;
}

function normalizeLabels(
  labelNames: readonly string[] | undefined,
  labels: LabelValues | undefined,
): LabelValues {
  if (!labelNames || labelNames.length === 0) return Object.freeze({});
  const out: Record<string, string> = {};
  for (const name of labelNames) {
    const raw = labels?.[name];
    out[name] = raw === undefined || raw === null ? '_' : String(raw);
  }
  return Object.freeze(out);
}

function labelKey(labels: LabelValues): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${labels[k]}`).join('|');
}

function stringifyLabels(labels: LabelValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    out[k] = v === undefined || v === null ? '_' : String(v);
  }
  return out;
}

function renderLabels(labels: LabelValues | Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = keys.map(
    (k) => `${k}="${escapeLabelValue(String((labels as Record<string, unknown>)[k]))}"`,
  );
  return `{${parts.join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? '+Inf' : '-Inf';
  // 与 prom-client 一致：非整数走定长；避免 1e-7 之类科学计数
  const str = String(value);
  if (NUMERIC_RE.test(str)) return str;
  return value.toFixed(6);
}

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** 进程内单例 registry。业务方一般直接消费它。 */
export const defaultRegistry = new MetricsRegistry();

/**
 * P9-2 内置指标句柄：与计划文档表格一一对应，业务方可以直接 import 用。
 * 全部注册在 [defaultRegistry](file:///./metrics.ts) 上；测试可以 `defaultRegistry.reset()` 清空。
 */
export const AI_METRICS = {
  chatTokensPrompt: defaultRegistry.createCounter({
    name: 'ai_chat_tokens_prompt',
    help: 'LLM prompt tokens consumed per (provider, model).',
    labelNames: ['provider', 'model'],
  }),
  chatTokensCompletion: defaultRegistry.createCounter({
    name: 'ai_chat_tokens_completion',
    help: 'LLM completion tokens produced per (provider, model).',
    labelNames: ['provider', 'model'],
  }),
  chatLatencyTtfb: defaultRegistry.createHistogram({
    name: 'ai_chat_latency_ttfb_ms',
    help: 'LLM time to first byte in milliseconds.',
    labelNames: ['provider', 'model'],
    buckets: DEFAULT_LATENCY_BUCKETS_MS,
  }),
  toolExecDuration: defaultRegistry.createHistogram({
    name: 'ai_tool_exec_duration_ms',
    help: 'Tool execution duration in milliseconds (pre → post).',
    labelNames: ['tool'],
    buckets: DEFAULT_LATENCY_BUCKETS_MS,
  }),
  toolErrorCount: defaultRegistry.createCounter({
    name: 'ai_tool_error_count',
    help: 'Failed tool executions grouped by (tool, code).',
    labelNames: ['tool', 'code'],
  }),
  ttsLatencyFirstChunk: defaultRegistry.createHistogram({
    name: 'ai_tts_latency_first_chunk_ms',
    help: 'TTS first audio chunk latency in milliseconds.',
    labelNames: ['provider'],
    buckets: DEFAULT_LATENCY_BUCKETS_MS,
  }),
  asrLatencyFinal: defaultRegistry.createHistogram({
    name: 'ai_asr_latency_final_ms',
    help: 'ASR final result latency in milliseconds.',
    labelNames: ['provider'],
    buckets: DEFAULT_LATENCY_BUCKETS_MS,
  }),
  agentStepsPerTurn: defaultRegistry.createHistogram({
    name: 'ai_agent_steps_per_turn',
    help: 'Number of agent steps per completed turn.',
    buckets: DEFAULT_TOKEN_BUCKETS,
  }),
} as const;

export type AiMetricKey = keyof typeof AI_METRICS;
