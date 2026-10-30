import { describe, expect, it, afterEach } from 'vitest';

import type { SpanExporter, SpanRecord } from '../../src/observability/tracing';
import {
  AI_OTLP_ENDPOINT_ENV,
  NOOP_TRACER,
  configureTracing,
  disableTracing,
  getTracer,
  isTracingEnabled,
  readOtlpEndpoint,
} from '../../src/observability/tracing';

let idCounter = 0;
function deterministicIds() {
  return {
    traceId: () => `trace-${(++idCounter).toString().padStart(4, '0')}`.padEnd(32, '0'),
    spanId: () => `span-${(++idCounter).toString().padStart(4, '0')}`.padEnd(16, '0'),
  };
}

function fakeClock() {
  let t = 1000;
  return () => {
    t += 5;
    return t;
  };
}

describe('tracing · configureTracing / getTracer', () => {
  afterEach(() => {
    disableTracing();
    idCounter = 0;
  });

  it('未 configure 前 getTracer() 返回 no-op（isTracingEnabled=false）', () => {
    expect(isTracingEnabled()).toBe(false);
    const tracer = getTracer();
    expect(tracer).toBe(NOOP_TRACER);
    const span = tracer.startSpan('noop');
    expect(span.isRecording()).toBe(false);
  });

  it('configureTracing 后返回真实 tracer；startSpan 分配 traceId / spanId', () => {
    const tracer = configureTracing({
      serviceName: 'ai-runtime-test',
      idGenerator: deterministicIds(),
      now: fakeClock(),
    });
    expect(isTracingEnabled()).toBe(true);
    expect(tracer.serviceName).toBe('ai-runtime-test');

    const span = tracer.startSpan('chat.turn', {
      kind: 'internal',
      attributes: { 'chat.session_id': 's1' },
    });
    span.setAttribute('llm.model', 'gpt-4');
    span.setStatus({ code: 'ok' });
    span.end();

    const records = tracer.recorder.finishedSpans;
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.name).toBe('chat.turn');
    expect(r.kind).toBe('internal');
    expect(r.traceId).toMatch(/^trace-/);
    expect(r.spanId).toMatch(/^span-/);
    expect(r.attributes).toMatchObject({
      'chat.session_id': 's1',
      'llm.model': 'gpt-4',
    });
    expect(r.status).toEqual({ code: 'ok' });
    expect(r.durationMs).toBeGreaterThan(0);
  });
});

describe('tracing · attribute redaction', () => {
  afterEach(() => {
    disableTracing();
  });

  it('setAttribute / setAttributes 走 redaction；apiKey / token 被替换为 ***', () => {
    const tracer = configureTracing({ idGenerator: deterministicIds(), now: fakeClock() });
    const span = tracer.startSpan('llm.request');
    span.setAttribute('apiKey', 'sk-live-xxx');
    span.setAttributes({ Authorization: 'Bearer eyJ', 'chat.model': 'gpt-4' });
    span.end();

    const r = tracer.recorder.finishedSpans[0]!;
    expect(r.attributes.apiKey).toBe('***');
    expect(r.attributes.Authorization).toBe('***');
    expect(r.attributes['chat.model']).toBe('gpt-4');
  });
});

describe('tracing · withSpan 自动状态管理', () => {
  afterEach(() => {
    disableTracing();
  });

  it('resolve → status=ok，reject → status=error + recordException', async () => {
    const tracer = configureTracing({ idGenerator: deterministicIds(), now: fakeClock() });

    const ok = await tracer.withSpan('chat.turn', undefined, async (span) => {
      span.addEvent('llm.prompt.sent');
      return 42;
    });
    expect(ok).toBe(42);

    await expect(
      tracer.withSpan('llm.request', undefined, async () => {
        throw Object.assign(new Error('rate limited'), { code: 'E_QUOTA' });
      }),
    ).rejects.toThrow('rate limited');

    const [okRec, errRec] = tracer.recorder.finishedSpans;
    expect(okRec!.status).toEqual({ code: 'ok' });
    expect(errRec!.status).toEqual({ code: 'error', message: 'rate limited' });
    const excEvent = errRec!.events.find((e) => e.name === 'exception');
    expect(excEvent).toBeTruthy();
    expect(excEvent?.attributes).toMatchObject({
      'exception.type': 'Error',
      'exception.message': 'rate limited',
      'exception.code': 'E_QUOTA',
    });
  });

  it('currentSpan() 在 withSpan 内部返回当前 span，外部返回 undefined', async () => {
    const tracer = configureTracing({ idGenerator: deterministicIds(), now: fakeClock() });
    expect(tracer.currentSpan()).toBeUndefined();

    await tracer.withSpan('chat.turn', undefined, async () => {
      const active = tracer.currentSpan();
      expect(active?.name).toBe('chat.turn');
    });

    expect(tracer.currentSpan()).toBeUndefined();
  });

  it('子 span 自动继承 parent traceId + parentSpanId', async () => {
    const tracer = configureTracing({ idGenerator: deterministicIds(), now: fakeClock() });
    await tracer.withSpan('chat.turn', undefined, async (turn) => {
      const child = tracer.startSpan('llm.request');
      child.end();
      const [childRec] = tracer.recorder.finishedSpans;
      expect(childRec!.traceId).toBe(turn.context.traceId);
      expect(childRec!.parentSpanId).toBe(turn.context.spanId);
    });
  });
});

describe('tracing · exporter', () => {
  afterEach(() => {
    disableTracing();
  });

  it('未提供 exporter 时也不出网：只走 in-memory recorder', () => {
    const tracer = configureTracing({ idGenerator: deterministicIds(), now: fakeClock() });
    tracer.startSpan('t').end();
    expect(tracer.recorder.finishedSpans).toHaveLength(1);
  });

  it('注入自定义 exporter → 收到 finished span 副本', () => {
    const finished: SpanRecord[] = [];
    const exporter: SpanExporter = {
      export: (spans) => finished.push(...spans),
    };
    const tracer = configureTracing({
      idGenerator: deterministicIds(),
      now: fakeClock(),
      exporter,
    });
    tracer.startSpan('t').end();
    expect(finished).toHaveLength(1);
    expect(finished[0]!.name).toBe('t');
  });

  it('exporter 抛错不影响主流程', () => {
    const exporter: SpanExporter = {
      export: () => {
        throw new Error('down');
      },
    };
    const tracer = configureTracing({
      idGenerator: deterministicIds(),
      now: fakeClock(),
      exporter,
    });
    expect(() => tracer.startSpan('t').end()).not.toThrow();
  });
});

describe('tracing · disabled tracer 完全 no-op', () => {
  afterEach(() => {
    disableTracing();
  });

  it('enabled=false 时 startSpan 返回全局 NoopSpan 单例', () => {
    const tracer = configureTracing({
      enabled: false,
      idGenerator: deterministicIds(),
      now: fakeClock(),
    });
    const s1 = tracer.startSpan('a');
    const s2 = tracer.startSpan('b');
    expect(s1.isRecording()).toBe(false);
    expect(s2.isRecording()).toBe(false);
    expect(s1).toBe(s2);
    s1.end();
    expect(tracer.recorder.finishedSpans).toHaveLength(0);
  });
});

describe('tracing · readOtlpEndpoint', () => {
  it('未设置或空白时返回 undefined（默认关闭，不出网）', () => {
    expect(readOtlpEndpoint({})).toBeUndefined();
    expect(readOtlpEndpoint({ [AI_OTLP_ENDPOINT_ENV]: '' })).toBeUndefined();
    expect(readOtlpEndpoint({ [AI_OTLP_ENDPOINT_ENV]: '   ' })).toBeUndefined();
  });

  it('设置后返回 trim 后的字符串', () => {
    expect(readOtlpEndpoint({ [AI_OTLP_ENDPOINT_ENV]: 'http://localhost:4318 ' })).toBe(
      'http://localhost:4318',
    );
  });
});
