/**
 * 模型质量聚合（docs/design/model-quality.md §2、§3）：比率、两种计数口径、开关、分位数、
 * 突发排除、缓存命中率、上一周期、时间序列、请求明细。
 */
import type { QualityRecord } from '@nomi-ai/types';

import {
  bucketStart,
  dist,
  listRequests,
  modelFamily,
  queryQuality,
  seriesQuality,
} from '../../../src/usage/quality/aggregate';

const T0 = new Date(2026, 9, 24, 10, 0, 0).getTime();
let seq = 0;
function rec(o: Partial<QualityRecord> = {}): QualityRecord {
  return {
    id: `r${++seq}`,
    layer: 'gateway',
    ts: T0 + seq * 1000,
    client: 'claude',
    source: 'thirdParty',
    provider: 'amux',
    keyId: 'k1',
    model: 'amux/deepseek/deepseek-v4.1-flash',
    ingress: 'messages',
    wire: 'responses',
    stream: true,
    outcome: 'ok',
    status: 200,
    timing: { headersMs: 200, firstContentMs: 1000, lastContentMs: 2000, endMs: 2100 },
    tokens: { input: 100, output: 101, cacheRead: 300 },
    ...o,
  };
}
const q = (o: Partial<Parameters<typeof queryQuality>[1]> = {}) => ({
  from: T0,
  to: T0 + 86_400_000,
  ...o,
});

describe('modelFamily', () => {
  it('去掉供应商前缀与快照后缀，保留版本号', () => {
    expect(modelFamily('amux/deepseek/deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
    expect(modelFamily('zp/GLM-5')).toBe('glm-5');
    expect(modelFamily('anthropic/claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(modelFamily('gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(modelFamily('qwen3:32b')).toBe('qwen3');
    expect(modelFamily('gpt-5-latest')).toBe('gpt-5');
    expect(modelFamily(undefined)).toBeUndefined();
  });
});

describe('dist', () => {
  it('均值与最近秩分位数；空与负值', () => {
    const d = dist(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(d).toMatchObject({ n: 100, mean: 50.5, p50: 50, p90: 90, p99: 99 });
    expect(dist([])).toEqual({ n: 0 });
    expect(dist([-1, Number.NaN, 5])).toMatchObject({ n: 1, p50: 5 });
  });
});

describe('queryQuality', () => {
  it('成功率 / 失败率默认不含取消与请求被拒；开关打开后计入', () => {
    const rs = [
      rec(),
      rec(),
      rec({ outcome: 'stream-break' }),
      rec({ outcome: 'client-cancel', cancelPhase: 'during' }),
      rec({ outcome: 'client-cancel' }),
      rec({ outcome: 'request-rejected', status: 400 }),
    ];
    const a = queryQuality(rs, q()).total;
    expect(a).toMatchObject({ requests: 6, ok: 2, failed: 1, cancelled: 2 });
    expect(a.cancelBeforeFirst).toBe(1);
    expect(a.cancelDuring).toBe(1);
    expect(a.successRate).toBeCloseTo(2 / 3);
    expect(a.failureRate).toBeCloseTo(1 / 3);
    expect(a.cancelRate).toBeCloseTo(2 / 6);
    expect(a.failures).toEqual({ 'stream-break': 1 });
    const b = queryQuality(rs, q({ cancelInDenominator: true, includeRejected: true })).total;
    expect(b.failed).toBe(2);
    expect(b.successRate).toBeCloseTo(2 / 6);
    expect(b.failures).toEqual({ 'stream-break': 1, 'request-rejected': 1 });
  });

  it('断流率 = 已开始输出的流里没正常结束的比例；回退率', () => {
    const rs = [
      rec(),
      rec({ outcome: 'stream-break' }),
      rec({ outcome: 'idle-timeout' }),
      // 首字前失败：不算「已开始输出」
      rec({ outcome: 'upstream-5xx', timing: { endMs: 300 } }),
      rec({
        attempts: [
          { provider: 'a', keyId: 'k0', model: 'm', outcome: 'rate-limit', status: 429, ms: 50 },
          { provider: 'amux', keyId: 'k1', model: 'm', outcome: 'ok', status: 200, ms: 2000 },
        ],
      }),
    ];
    const s = queryQuality(rs, q()).total;
    expect(s.streamBreak).toBe(2);
    expect(s.streamBreakRate).toBeCloseTo(2 / 4);
    expect(s.fallback).toBe(1);
    expect(s.attempts).toBe(6);
  });

  it('按尝试计：回退前失败的 Key 记一次失败，不被后面的成功掩盖', () => {
    const rs = [
      rec({
        attempts: [
          { provider: 'p1', keyId: 'kA', model: 'm', outcome: 'rate-limit', status: 429, ms: 50 },
          { provider: 'p2', keyId: 'kB', model: 'm', outcome: 'ok', status: 200, ms: 2000 },
        ],
        provider: 'p2',
        keyId: 'kB',
      }),
    ];
    const byReq = queryQuality(rs, q({ groupBy: 'key' }));
    expect(byReq.groups.map((g) => g.label)).toEqual(['kB']);
    const byAtt = queryQuality(rs, q({ groupBy: 'key', countBy: 'attempt' }));
    const kA = byAtt.groups.find((g) => g.label === 'kA')!;
    const kB = byAtt.groups.find((g) => g.label === 'kB')!;
    expect(kA).toMatchObject({ requests: 1, failed: 1, ok: 0 });
    expect(kA.failures).toEqual({ 'rate-limit': 1 });
    expect(kB).toMatchObject({ requests: 1, ok: 1 });
    expect(byAtt.total.requests).toBe(2);
  });

  it('TTFT / TPOT / E2E / 输出速度；突发（整段吐出）不进 TPOT 与 tok/s，单独计数', () => {
    const rs = [
      rec(), // 生成 1000 ms、101 个输出 → TPOT 10 ms、101 tok/s
      rec({
        burst: true,
        timing: { firstContentMs: 8000, lastContentMs: 8020, endMs: 8100 },
        tokens: { input: 10, output: 82 },
      }),
      rec({ stream: false, timing: { firstContentMs: 3000, endMs: 3000 } }),
    ];
    const s = queryQuality(rs, q()).total;
    expect(s.burst).toBe(1);
    expect(s.tpot).toMatchObject({ n: 1, p50: 10 });
    expect(s.outputTps).toMatchObject({ n: 1, p50: 101 });
    expect(s.ttft.n).toBe(3);
    expect(s.e2e).toMatchObject({ n: 3, p50: 3000 });
    expect(s.ttfb).toMatchObject({ n: 1, p50: 200 });
  });

  it('缓存命中率：按 token（缓存读 ÷ 输入总量）与按请求', () => {
    const rs = [
      rec({ tokens: { input: 100, cacheRead: 300, output: 1 } }),
      rec({ tokens: { input: 100, cacheWrite: 100, output: 1 } }),
      rec({ tokens: {} }),
    ];
    const s = queryQuality(rs, q()).total;
    expect(s.cacheHitTokenRate).toBeCloseTo(300 / 600);
    expect(s.cacheHitRequestRate).toBeCloseTo(1 / 2);
    expect(s.tokens).toEqual({
      input: 200,
      output: 2,
      cacheRead: 300,
      cacheWrite: 100,
      reasoning: 0,
    });
  });

  it('筛选、分组、显示名、口径与上一周期；费用只在有定价时给', () => {
    const rs = [
      rec({ provider: 'p1', cost: 0.01 }),
      rec({ provider: 'p2' }),
      rec({ provider: 'p2', client: 'nomi', source: 'nomi' }),
      rec({ layer: 'cli', source: 'official', provider: 'anthropic' }),
      rec({ ts: T0 - 3600_000 }), // 上一周期
    ];
    const r = queryQuality(
      rs,
      q({ to: T0 + 3600_000, groupBy: 'provider', withPrevious: true }),
      (dim, key) => (dim === 'provider' && key === 'p2' ? 'Provider Two' : undefined),
    );
    expect(r.total.requests).toBe(3);
    expect(r.groups.map((g) => [g.label, g.requests])).toEqual([
      ['Provider Two', 2],
      ['p1', 1],
    ]);
    expect(r.groups.find((g) => g.key === 'p1')!.cost).toBeCloseTo(0.01);
    expect(r.groups.find((g) => g.key === 'p2')!.cost).toBeUndefined();
    expect(r.previous?.requests).toBe(1);
    expect(r.minSamples).toBe(20);
    expect(queryQuality(rs, q({ filters: { client: ['nomi'] } })).total.requests).toBe(1);
    expect(queryQuality(rs, q({ layer: 'cli' })).total.requests).toBe(1);
    expect(queryQuality(rs, q({ groupBy: 'protocol' })).groups.map((g) => g.key)).toEqual([
      'messages→responses',
    ]);
    expect(queryQuality(rs, q({ groupBy: 'modelFamily' })).groups.map((g) => g.key)).toEqual([
      'deepseek-v4.1-flash',
    ]);
  });
});

describe('seriesQuality', () => {
  it('按小时分桶，每组一条；空桶为 null', () => {
    const rs = [
      rec({ ts: T0 + 60_000 }),
      rec({ ts: T0 + 120_000, outcome: 'stream-break' }),
      rec({ ts: T0 + 2 * 3600_000 + 1 }),
    ];
    const s = seriesQuality(rs, {
      ...q({ to: T0 + 3 * 3600_000 }),
      bucket: 'hour',
      metric: 'successRate',
    });
    expect(s.buckets).toEqual([T0, T0 + 3600_000, T0 + 2 * 3600_000]);
    expect(s.series).toHaveLength(1);
    expect(s.series[0]!.values).toEqual([0.5, null, 1]);
    const p = seriesQuality(rs, {
      ...q({ to: T0 + 3 * 3600_000, groupBy: 'outcome' }),
      bucket: 'day',
      metric: 'requests',
    });
    expect(p.buckets).toEqual([bucketStart(T0, 'day')]);
    expect(p.series.map((x) => [x.key, x.values])).toEqual([
      ['ok', [2]],
      ['stream-break', [1]],
    ]);
  });
});

describe('listRequests', () => {
  it('倒序、分页、筛选', () => {
    const rs = [rec(), rec({ client: 'grok' }), rec()];
    const r = listRequests(rs, { from: T0, to: T0 + 86_400_000, limit: 2 });
    expect(r.total).toBe(3);
    expect(r.items.map((x) => x.id)).toEqual([rs[2]!.id, rs[1]!.id]);
    const g = listRequests(rs, {
      from: T0,
      to: T0 + 86_400_000,
      limit: 10,
      filters: { client: ['grok'] },
    });
    expect(g.items.map((x) => x.client)).toEqual(['grok']);
  });
});
