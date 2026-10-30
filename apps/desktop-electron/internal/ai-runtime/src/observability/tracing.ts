/**
 * ai-runtime · tracing / OpenTelemetry 兼容层（P9-3 · Polish C）
 *
 * 设计目标
 * --------
 * 1. **接口先行**：对齐 OpenTelemetry 语义（`traceId` / `spanId` / `parentSpanId`
 *    / `SpanKind` / `SpanStatus` / attributes / events），业务方按 OTel 心智写代码；
 * 2. **默认零依赖**：默认给一个 **in-memory recorder** 实现（也是 no-op 的一种），
 *    不引 `@opentelemetry/sdk-node` 硬依赖；`AI_OTLP_ENDPOINT` 关闭时**不产生任何
 *    网络请求**（满足 P9 §退出准则 6：Sentry/OTLP 关闭时无网络请求，防隐私泄漏）；
 * 3. **可切换**：业务方（Electron 主进程）想真接 OTLP，实现 `SpanExporter` 并
 *    `configureTracing({ exporter })` 即可，SDK 层不感知；
 * 4. **redaction**：attributes 走 [redaction](file:///./redaction.ts) 中间件，避免 key /
 *    token 通过 span attributes 出网；
 * 5. **P9-2 联动**：tracer 内部记录 span duration，方便直接拿来做 metrics observe。
 *
 * 关联：
 * - [logger.ts](file:///./logger.ts) 结构化日志 + `traceId` binding
 * - [metrics.ts](file:///./metrics.ts) `ai_chat_latency_ttfb_ms` 等 histogram
 */

import { createRedactor, type RedactOptions } from './redaction';

export const AI_OTLP_ENDPOINT_ENV = 'AI_OTLP_ENDPOINT';

/** 与 OTel 保持一致的 SpanKind（子集）。 */
export type SpanKind = 'internal' | 'client' | 'server' | 'producer' | 'consumer';

/** OTel StatusCode 子集：`unset` = 未 finish、`ok` = 成功、`error` = 失败。 */
export type SpanStatusCode = 'unset' | 'ok' | 'error';

export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

export type SpanAttributeValue =
  string | number | boolean | ReadonlyArray<string | number | boolean>;

export type SpanAttributes = Readonly<Record<string, SpanAttributeValue | undefined>>;

export interface SpanEvent {
  name: string;
  timeMs: number;
  attributes?: SpanAttributes;
}

/** 一次 span 的最终快照（导出 / 断言用）。 */
export interface SpanRecord {
  name: string;
  kind: SpanKind;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, SpanAttributeValue>;
  events: SpanEvent[];
}

/** OTel 里的 SpanContext（可跨进程 propagate 的最小信息）。 */
export interface SpanContext {
  traceId: string;
  spanId: string;
}

/** 用户拿到的活跃 span 句柄。 */
export interface Span {
  readonly name: string;
  readonly kind: SpanKind;
  readonly context: SpanContext;
  setAttribute(key: string, value: SpanAttributeValue | undefined): void;
  setAttributes(attrs: SpanAttributes): void;
  addEvent(name: string, attrs?: SpanAttributes): void;
  setStatus(status: SpanStatus): void;
  recordException(err: unknown): void;
  end(endTimeMs?: number): void;
  isRecording(): boolean;
}

export interface StartSpanOptions {
  kind?: SpanKind;
  attributes?: SpanAttributes;
  parent?: SpanContext;
  /** 强制覆盖开始时间；测试与 propagation 用。 */
  startTimeMs?: number;
}

export interface Tracer {
  readonly serviceName: string;
  startSpan(name: string, options?: StartSpanOptions): Span;
  /**
   * 便捷 `withSpan` —— 自动 finish、异常 setStatus('error') + recordException。
   * 常用姿势：`await tracer.withSpan('chat.turn', {...}, async (span) => {...})`。
   */
  withSpan<T>(
    name: string,
    options: StartSpanOptions | undefined,
    fn: (span: Span) => T | Promise<T>,
  ): Promise<T>;
  /** 当前调用栈的活跃 span（withSpan 内部生效，其他场景返回 undefined）。 */
  currentSpan(): Span | undefined;
}

export interface SpanExporter {
  /** 收到已 finish 的 span；实现可选异步导出到 OTLP / 日志。 */
  export(spans: SpanRecord[]): void | Promise<void>;
  /** 优雅关闭（flush + close）。可选。 */
  shutdown?(): void | Promise<void>;
}

export interface TracerOptions {
  serviceName?: string;
  /** 默认 tracer 是否处于记录状态；false = 纯 no-op（不分配对象）。 */
  enabled?: boolean;
  /** 已 finish span 的 exporter；未提供则只走内存 recorder。 */
  exporter?: SpanExporter;
  /** attribute redaction 配置；未提供使用默认敏感字段列表。 */
  redact?: RedactOptions;
  /**
   * 自定义 traceId / spanId 生成器（16 / 8 bytes hex，OTel 兼容）。
   * 测试可注入确定性 ID。
   */
  idGenerator?: {
    traceId(): string;
    spanId(): string;
  };
  /** 时钟；未提供使用 `performance.now() ?? Date.now()`。 */
  now?: () => number;
}

const NO_STATUS: SpanStatus = { code: 'unset' };

class NoopSpan implements Span {
  readonly name = '';
  readonly kind: SpanKind = 'internal';
  readonly context: SpanContext = { traceId: '0'.repeat(32), spanId: '0'.repeat(16) };
  setAttribute(): void {}
  setAttributes(): void {}
  addEvent(): void {}
  setStatus(): void {}
  recordException(): void {}
  end(): void {}
  isRecording(): boolean {
    return false;
  }
}

const NOOP_SPAN = new NoopSpan();

class RecordingSpan implements Span {
  private record: SpanRecord;
  private ended = false;

  constructor(
    record: SpanRecord,
    private readonly redactor: (input: unknown) => unknown,
    private readonly clock: () => number,
    private readonly onEnd: (r: SpanRecord) => void,
  ) {
    this.record = record;
  }

  get name(): string {
    return this.record.name;
  }
  get kind(): SpanKind {
    return this.record.kind;
  }
  get context(): SpanContext {
    return { traceId: this.record.traceId, spanId: this.record.spanId };
  }

  setAttribute(key: string, value: SpanAttributeValue | undefined): void {
    if (this.ended || value === undefined) return;
    const redacted = this.redactor({ [key]: value }) as Record<string, SpanAttributeValue>;
    this.record.attributes[key] = redacted[key]!;
  }

  setAttributes(attrs: SpanAttributes): void {
    if (this.ended) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined) continue;
      this.setAttribute(k, v);
    }
  }

  addEvent(name: string, attrs?: SpanAttributes): void {
    if (this.ended) return;
    const redactedAttrs = attrs
      ? (this.redactor(attrs) as Record<string, SpanAttributeValue>)
      : undefined;
    this.record.events.push({
      name,
      timeMs: this.clock(),
      ...(redactedAttrs ? { attributes: redactedAttrs } : {}),
    });
  }

  setStatus(status: SpanStatus): void {
    if (this.ended) return;
    this.record.status = { code: status.code, message: status.message };
  }

  recordException(err: unknown): void {
    if (this.ended) return;
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
    const name = err instanceof Error ? err.name : 'Exception';
    const code =
      err &&
      typeof err === 'object' &&
      'code' in err &&
      typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : undefined;
    this.addEvent('exception', {
      'exception.type': name,
      'exception.message': message,
      ...(code ? { 'exception.code': code } : {}),
    });
    if (this.record.status.code === 'unset') {
      this.record.status = { code: 'error', message };
    }
  }

  end(endTimeMs?: number): void {
    if (this.ended) return;
    this.ended = true;
    this.record.endTimeMs = endTimeMs ?? this.clock();
    this.record.durationMs = Math.max(0, this.record.endTimeMs - this.record.startTimeMs);
    this.onEnd(this.record);
  }

  isRecording(): boolean {
    return !this.ended;
  }
}

/** 默认 traceId / spanId 生成器（16 / 8 bytes hex）。 */
function defaultIdGenerator(): { traceId(): string; spanId(): string } {
  return {
    traceId: () => randomHex(32),
    spanId: () => randomHex(16),
  };
}

function randomHex(chars: number): string {
  // 优先 crypto.getRandomValues；不可用时退回 Math.random（测试环境足够）。
  try {
    const g = globalThis as { crypto?: { getRandomValues?: (arr: Uint8Array) => Uint8Array } };
    if (g.crypto?.getRandomValues) {
      const bytes = new Uint8Array(chars / 2);
      g.crypto.getRandomValues(bytes);
      let out = '';
      for (const b of bytes) out += b.toString(16).padStart(2, '0');
      return out;
    }
  } catch {
    // fallthrough
  }
  let out = '';
  while (out.length < chars) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out.slice(0, chars);
}

class InMemoryRecorderExporter implements SpanExporter {
  readonly finishedSpans: SpanRecord[] = [];
  export(spans: SpanRecord[]): void {
    for (const s of spans) this.finishedSpans.push(s);
  }
  clear(): void {
    this.finishedSpans.length = 0;
  }
}

class InternalTracer implements Tracer {
  readonly serviceName: string;
  private readonly enabled: boolean;
  private readonly redactor: (input: unknown) => unknown;
  private readonly clock: () => number;
  private readonly ids: { traceId(): string; spanId(): string };
  private readonly exporter?: SpanExporter;
  private readonly stack: RecordingSpan[] = [];
  readonly recorder: InMemoryRecorderExporter;

  constructor(opts: TracerOptions) {
    this.serviceName = opts.serviceName ?? 'ai-runtime';
    this.enabled = opts.enabled ?? true;
    this.redactor = createRedactor(opts.redact);
    this.clock =
      opts.now ??
      (() =>
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now());
    this.ids = opts.idGenerator ?? defaultIdGenerator();
    this.exporter = opts.exporter;
    this.recorder = new InMemoryRecorderExporter();
  }

  startSpan(name: string, options: StartSpanOptions = {}): Span {
    if (!this.enabled) return NOOP_SPAN;
    const parent = options.parent ?? this.currentSpan()?.context;
    const traceId = parent?.traceId ?? this.ids.traceId();
    const spanId = this.ids.spanId();
    const startTimeMs = options.startTimeMs ?? this.clock();
    const attributesInput = options.attributes
      ? (this.redactor(options.attributes) as Record<string, SpanAttributeValue>)
      : {};
    const record: SpanRecord = {
      name,
      kind: options.kind ?? 'internal',
      traceId,
      spanId,
      ...(parent?.spanId ? { parentSpanId: parent.spanId } : {}),
      startTimeMs,
      status: { ...NO_STATUS },
      attributes: attributesInput,
      events: [],
    };
    const span = new RecordingSpan(record, this.redactor, this.clock, (r) => {
      this.recorder.export([r]);
      if (this.exporter) {
        try {
          void this.exporter.export([r]);
        } catch {
          // exporter 失败不能阻塞主流程；后续 OTLP HTTP exporter 会自己 retry
        }
      }
      const idx = this.stack.indexOf(span);
      if (idx >= 0) this.stack.splice(idx, 1);
    });
    return span;
  }

  async withSpan<T>(
    name: string,
    options: StartSpanOptions | undefined,
    fn: (span: Span) => T | Promise<T>,
  ): Promise<T> {
    const span = this.startSpan(name, options ?? {});
    if (span instanceof RecordingSpan) this.stack.push(span);
    try {
      const out = await fn(span);
      if (span.isRecording()) {
        span.setStatus({ code: 'ok' });
        span.end();
      }
      return out;
    } catch (err) {
      if (span.isRecording()) {
        span.recordException(err);
        span.end();
      }
      throw err;
    }
  }

  currentSpan(): Span | undefined {
    const top = this.stack[this.stack.length - 1];
    return top?.isRecording() ? top : undefined;
  }
}

/** 全局 no-op tracer；默认 tracer 未配置时使用。 */
class NoopTracer implements Tracer {
  readonly serviceName = 'noop';
  startSpan(): Span {
    return NOOP_SPAN;
  }
  async withSpan<T>(
    _name: string,
    _options: StartSpanOptions | undefined,
    fn: (span: Span) => T | Promise<T>,
  ): Promise<T> {
    return fn(NOOP_SPAN);
  }
  currentSpan(): undefined {
    return undefined;
  }
}

const NOOP_TRACER: Tracer = new NoopTracer();

let globalTracer: Tracer = NOOP_TRACER;

/**
 * 配置全局 tracer。业务方在 `runtime.configure()` 阶段调用一次。
 *
 * - 未调用时：`getTracer()` 返回 no-op tracer，`startSpan` 也不分配对象；
 * - 调用后：`getTracer()` 返回配置好的 tracer；`AI_OTLP_ENDPOINT` 关闭时
 *   （即业务方不注入 exporter）**不产生任何网络请求**。
 */
export function configureTracing(opts: TracerOptions = {}): Tracer {
  const tracer = new InternalTracer(opts);
  globalTracer = tracer;
  return tracer;
}

/** 关掉 tracing，还原到 no-op。 */
export function disableTracing(): void {
  globalTracer = NOOP_TRACER;
}

export function getTracer(): Tracer {
  return globalTracer;
}

/**
 * 读取 `AI_OTLP_ENDPOINT` 环境变量。空字符串视为未配置。
 * Polish C 阶段仅提供**读取语义**；实际 OTLP HTTP exporter 留到业务方接线。
 */
export function readOtlpEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[AI_OTLP_ENDPOINT_ENV];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 便捷判定：当前 tracer 是否为 no-op（用于日志 / doctor 报告）。
 */
export function isTracingEnabled(): boolean {
  return globalTracer !== NOOP_TRACER;
}

export { NOOP_TRACER };
