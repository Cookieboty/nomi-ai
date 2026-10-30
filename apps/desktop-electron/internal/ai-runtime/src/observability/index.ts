/**
 * ai-runtime 可观测栈入口。
 *
 * 目前包含：
 * - [StructuredLogger](file:///./logger.ts)：结构化日志器 + 子 logger + 级别短路 + Error 序列化；
 * - [redaction](file:///./redaction.ts)：默认脱敏字段列表 + 深度嵌套 / 循环引用防御；
 * - [metrics](file:///./metrics.ts)：Counter / Histogram / Gauge + Prometheus text
 *   导出，包含 P9-2 内置 8 指标；
 * - [tracing](file:///./tracing.ts)：OpenTelemetry 兼容 Tracer / Span 接口 + 默认
 *   in-memory recorder，`AI_OTLP_ENDPOINT` 环境变量点亮真实 OTLP exporter。
 */

export {
  LOG_LEVELS,
  createStructuredLogger,
  toRuntimeLoggerAdapter,
  type LogLevel,
  type LogRecord,
  type LogSink,
  type StructuredLogger,
  type StructuredLoggerOptions,
} from './logger';

export { DEFAULT_SENSITIVE_FIELDS, createRedactor, redact, type RedactOptions } from './redaction';

export {
  AI_METRICS,
  DEFAULT_LATENCY_BUCKETS_MS,
  DEFAULT_TOKEN_BUCKETS,
  MetricsRegistry,
  defaultRegistry,
  type AiMetricKey,
  type Counter,
  type CounterSnapshot,
  type Gauge,
  type GaugeSnapshot,
  type Histogram,
  type HistogramSnapshot,
  type LabelValues,
  type MetricDescriptor,
  type MetricKind,
  type MetricSnapshot,
} from './metrics';

export {
  AI_OTLP_ENDPOINT_ENV,
  NOOP_TRACER,
  configureTracing,
  disableTracing,
  getTracer,
  isTracingEnabled,
  readOtlpEndpoint,
  type Span,
  type SpanAttributeValue,
  type SpanAttributes,
  type SpanContext,
  type SpanEvent,
  type SpanExporter,
  type SpanKind,
  type SpanRecord,
  type SpanStatus,
  type SpanStatusCode,
  type StartSpanOptions,
  type Tracer,
  type TracerOptions,
} from './tracing';
