import { describe, expect, it, beforeEach } from 'vitest';

import {
  AI_METRICS,
  DEFAULT_LATENCY_BUCKETS_MS,
  MetricsRegistry,
  defaultRegistry,
  type CounterSnapshot,
  type GaugeSnapshot,
  type HistogramSnapshot,
} from '../../src/observability/metrics';

describe('MetricsRegistry · counter', () => {
  it('inc 累加 + 按 label 分桶', () => {
    const reg = new MetricsRegistry();
    const c = reg.createCounter({
      name: 'test_hits',
      help: 'test hits',
      labelNames: ['tool', 'code'],
    });
    c.inc({ tool: 'write_file', code: 'ok' });
    c.inc({ tool: 'write_file', code: 'ok' }, 3);
    c.inc({ tool: 'read_file', code: 'ok' });
    c.inc({ tool: 'write_file', code: 'fail' });

    const snap = reg.snapshot()[0] as CounterSnapshot;
    expect(snap.kind).toBe('counter');
    const byLabels = Object.fromEntries(
      snap.values.map((v) => [`${v.labels.tool}|${v.labels.code}`, v.value]),
    );
    expect(byLabels).toEqual({
      'write_file|ok': 4,
      'read_file|ok': 1,
      'write_file|fail': 1,
    });
  });

  it('undefined / null label 被兜底为 "_"', () => {
    const reg = new MetricsRegistry();
    const c = reg.createCounter({
      name: 't',
      help: 't',
      labelNames: ['provider', 'model'],
    });
    c.inc({ provider: 'openai' } as { provider: string }); // model 缺失
    c.inc({ provider: undefined, model: 'gpt' });

    const snap = reg.snapshot()[0] as CounterSnapshot;
    const modelValues = snap.values.map((v) => `${v.labels.provider}/${v.labels.model}`);
    expect(modelValues).toContain('openai/_');
    expect(modelValues).toContain('_/gpt');
  });

  it('非有限值（NaN / Infinity）被静默丢弃', () => {
    const reg = new MetricsRegistry();
    const c = reg.createCounter({ name: 't', help: '', labelNames: [] });
    c.inc({}, Number.NaN);
    c.inc({}, Number.POSITIVE_INFINITY);
    expect((reg.snapshot()[0] as CounterSnapshot).values).toHaveLength(0);
  });
});

describe('MetricsRegistry · histogram', () => {
  it('observe 落入正确的 bucket，_sum/_count 正确', () => {
    const reg = new MetricsRegistry();
    const h = reg.createHistogram({
      name: 'lat_ms',
      help: 'latency',
      labelNames: ['provider'],
      buckets: [10, 100, 1000],
    });
    h.observe(5, { provider: 'p1' }); // <=10 / <=100 / <=1000 都命中
    h.observe(50, { provider: 'p1' }); // <=100 / <=1000
    h.observe(500, { provider: 'p1' }); // <=1000
    h.observe(5000, { provider: 'p1' }); // 全部越界

    const snap = reg.snapshot()[0] as HistogramSnapshot;
    expect(snap.kind).toBe('histogram');
    expect(snap.buckets).toEqual([10, 100, 1000]);
    expect(snap.values[0]!.bucketCounts).toEqual([1, 2, 3]);
    expect(snap.values[0]!.count).toBe(4);
    expect(snap.values[0]!.sum).toBe(5555);
  });

  it('startTimer 使用 monotonic clock 记录一次 observe', async () => {
    const reg = new MetricsRegistry();
    const h = reg.createHistogram({ name: 't_ms', help: '', labelNames: [] });
    const end = h.startTimer();
    await new Promise((r) => setTimeout(r, 15));
    const elapsed = end();
    expect(elapsed).toBeGreaterThan(0);
    const snap = reg.snapshot()[0] as HistogramSnapshot;
    expect(snap.values[0]!.count).toBe(1);
    expect(snap.values[0]!.sum).toBeCloseTo(elapsed, 1);
  });

  it('默认 bucket 与 P9-2 表格一致', () => {
    const reg = new MetricsRegistry();
    const h = reg.createHistogram({ name: 't', help: '', labelNames: [] });
    expect(h.buckets).toEqual([...DEFAULT_LATENCY_BUCKETS_MS]);
  });
});

describe('MetricsRegistry · gauge', () => {
  it('set / inc / dec 都工作正常', () => {
    const reg = new MetricsRegistry();
    const g = reg.createGauge({ name: 'active', help: '', labelNames: ['profile'] });
    g.set(3, { profile: 'waifu' });
    g.inc({ profile: 'waifu' });
    g.dec({ profile: 'waifu' }, 2);
    const snap = reg.snapshot()[0] as GaugeSnapshot;
    expect(snap.kind).toBe('gauge');
    expect(snap.values[0]!.value).toBe(2);
  });
});

describe('MetricsRegistry · guardrails', () => {
  it('相同 name 不同 kind 会抛错', () => {
    const reg = new MetricsRegistry();
    reg.createCounter({ name: 'dup', help: '', labelNames: [] });
    expect(() => reg.createHistogram({ name: 'dup', help: '', labelNames: [] })).toThrow(
      /already registered as counter/,
    );
  });

  it('相同 name + 相同 kind 幂等（复用同一 state）', () => {
    const reg = new MetricsRegistry();
    const c1 = reg.createCounter({ name: 'x', help: '', labelNames: [] });
    const c2 = reg.createCounter({ name: 'x', help: '', labelNames: [] });
    c1.inc();
    c2.inc();
    const snap = reg.snapshot()[0] as CounterSnapshot;
    expect(snap.values[0]!.value).toBe(2);
  });
});

describe('MetricsRegistry · toPrometheus', () => {
  it('counter 输出 HELP + TYPE + label lines', () => {
    const reg = new MetricsRegistry();
    const c = reg.createCounter({
      name: 'ai_tool_error_count',
      help: 'errors',
      labelNames: ['tool', 'code'],
    });
    c.inc({ tool: 'write_file', code: 'E_TOOL_DENIED' }, 2);

    const text = reg.toPrometheus();
    expect(text).toContain('# HELP ai_tool_error_count errors');
    expect(text).toContain('# TYPE ai_tool_error_count counter');
    expect(text).toContain('ai_tool_error_count{code="E_TOOL_DENIED",tool="write_file"} 2');
  });

  it('histogram 输出 le bucket + _sum + _count + +Inf', () => {
    const reg = new MetricsRegistry();
    const h = reg.createHistogram({
      name: 'ai_chat_latency_ttfb_ms',
      help: 'ttfb',
      labelNames: ['provider'],
      buckets: [10, 100],
    });
    h.observe(5, { provider: 'p1' });
    h.observe(50, { provider: 'p1' });

    const text = reg.toPrometheus();
    expect(text).toContain('# TYPE ai_chat_latency_ttfb_ms histogram');
    expect(text).toContain('ai_chat_latency_ttfb_ms_bucket{le="10",provider="p1"} 1');
    expect(text).toContain('ai_chat_latency_ttfb_ms_bucket{le="100",provider="p1"} 2');
    expect(text).toContain('ai_chat_latency_ttfb_ms_bucket{le="+Inf",provider="p1"} 2');
    expect(text).toContain('ai_chat_latency_ttfb_ms_sum{provider="p1"} 55');
    expect(text).toContain('ai_chat_latency_ttfb_ms_count{provider="p1"} 2');
  });

  it('空 registry → 空字符串', () => {
    const reg = new MetricsRegistry();
    expect(reg.toPrometheus()).toBe('');
  });

  it('label value 内的引号 / 反斜杠 / 换行被转义', () => {
    const reg = new MetricsRegistry();
    const c = reg.createCounter({
      name: 'esc',
      help: 'help with "quotes"\nand newline',
      labelNames: ['msg'],
    });
    c.inc({ msg: 'quote"and\\backslash' });
    const text = reg.toPrometheus();
    expect(text).toContain('# HELP esc help with "quotes"\\nand newline');
    expect(text).toContain('esc{msg="quote\\"and\\\\backslash"} 1');
  });
});

describe('AI_METRICS · P9-2 内置 8 指标', () => {
  beforeEach(() => {
    defaultRegistry.reset();
  });

  it('全部内置 metric 都注册在 defaultRegistry 上', () => {
    const names = defaultRegistry.snapshot().map((m) => m.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'ai_chat_tokens_prompt',
        'ai_chat_tokens_completion',
        'ai_chat_latency_ttfb_ms',
        'ai_tool_exec_duration_ms',
        'ai_tool_error_count',
        'ai_tts_latency_first_chunk_ms',
        'ai_asr_latency_final_ms',
        'ai_agent_steps_per_turn',
      ]),
    );
  });

  it('chatTokensPrompt 按 provider / model 聚合，忽略 sessionId', () => {
    AI_METRICS.chatTokensPrompt.inc({ provider: 'openai', model: 'gpt-4', sessionId: 's1' }, 120);
    AI_METRICS.chatTokensPrompt.inc({ provider: 'openai', model: 'gpt-4', sessionId: 's2' }, 80);
    AI_METRICS.chatTokensPrompt.inc(
      { provider: 'anthropic', model: 'claude', sessionId: 's3' },
      50,
    );
    const snap = defaultRegistry
      .snapshot()
      .find((m) => m.name === 'ai_chat_tokens_prompt') as CounterSnapshot;
    expect(snap.values).toHaveLength(2);
    expect(snap.values.map((v) => v.value).sort((a, b) => a - b)).toEqual([50, 200]);
    expect(snap.values.every((v) => !('sessionId' in v.labels))).toBe(true);
  });

  it('toolErrorCount 与 P9-4 错误码表 (E_TOOL_DENIED) 打通', () => {
    AI_METRICS.toolErrorCount.inc({ tool: 'write_file', code: 'E_TOOL_DENIED' });
    const snap = defaultRegistry
      .snapshot()
      .find((m) => m.name === 'ai_tool_error_count') as CounterSnapshot;
    expect(snap.values[0]).toMatchObject({
      labels: { tool: 'write_file', code: 'E_TOOL_DENIED' },
      value: 1,
    });
  });
});
