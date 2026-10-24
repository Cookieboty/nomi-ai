/**
 * 网关进程内 RoutePlan 指标聚合：有界水库、top-K 交叉表、分位数、白名单。
 */
import { describe, expect, it } from 'vitest';

import { GatewayMetrics, KNOWN_LOSSES } from '../src/metrics';

describe('GatewayMetrics', () => {
  it('空快照：ok / since / requests=0', () => {
    const m = new GatewayMetrics({ now: () => 1_700_000_000_000 });
    expect(m.snapshot()).toEqual({
      ok: true,
      since: 1_700_000_000_000,
      requests: 0,
      byRouteQuality: {},
      byLoss: {},
      byClientIngressUpstream: [],
    });
  });

  it('按 routeQuality 计数并给出 e2e p50/p95；ttft 可选', () => {
    const m = new GatewayMetrics({ reservoirSize: 64 });
    for (let i = 1; i <= 100; i++) {
      m.observe({
        client: 'claude',
        ingress: 'messages',
        upstream: 'responses',
        routeQuality: 'good',
        losses: ['signature'],
        e2eMs: i * 10,
        ttftMs: i,
      });
    }
    m.observe({
      client: 'codex',
      ingress: 'responses',
      upstream: 'responses',
      routeQuality: 'lossless',
      e2eMs: 50,
    });
    m.observe({
      client: 'claude',
      ingress: 'messages',
      upstream: 'chat',
      routeQuality: 'degraded',
      losses: ['sealed-reasoning', 'freeform-tools'],
      e2eMs: 900,
    });
    const s = m.snapshot();
    expect(s.requests).toBe(102);
    expect(s.byRouteQuality.good?.n).toBe(100);
    // 水库 cap=64：dist.n 为样本容量；row.n 仍为总请求数；分位基于最近 64 点（370..1000 / 37..100）
    expect(s.byRouteQuality.good?.e2e).toMatchObject({ n: 64, p50: 680, p95: 970 });
    expect(s.byRouteQuality.good?.ttft).toMatchObject({ n: 64, p50: 68, p95: 97 });
    expect(s.byRouteQuality.lossless?.n).toBe(1);
    expect(s.byRouteQuality.lossless?.ttft).toBeUndefined();
    expect(s.byRouteQuality.degraded?.n).toBe(1);
    expect(s.byLoss).toEqual({
      signature: 100,
      'sealed-reasoning': 1,
      'freeform-tools': 1,
    });
  });

  it('未知 loss / routeQuality 不进对应桶；仍计 requests 与交叉表 unknown', () => {
    const m = new GatewayMetrics();
    m.observe({
      client: 'x',
      ingress: 'chat',
      upstream: 'chat',
      routeQuality: 'nope' as 'good',
      losses: ['signature', 'evil-loss', 'cache-control'],
      e2eMs: 10,
    });
    const s = m.snapshot();
    expect(s.requests).toBe(1);
    expect(s.byRouteQuality).toEqual({});
    expect(s.byLoss).toEqual({ signature: 1, 'cache-control': 1 });
    expect(s.byClientIngressUpstream).toEqual([
      expect.objectContaining({
        client: 'x',
        ingress: 'chat',
        upstream: 'chat',
        routeQuality: 'unknown',
        n: 1,
        losses: { signature: 1, 'cache-control': 1 },
      }),
    ]);
  });

  it('交叉维度按 n 降序；cap 后不再无界增长', () => {
    const m = new GatewayMetrics({ crossCap: 10, reservoirSize: 8 });
    for (let i = 0; i < 30; i++) {
      m.observe({
        client: `c${i}`,
        ingress: 'chat',
        upstream: 'chat',
        routeQuality: 'lossless',
        e2eMs: 1,
      });
    }
    // 再打几次已有键，确认不会因淘汰丢计数逻辑崩掉
    for (let i = 0; i < 5; i++) {
      m.observe({
        client: 'c0',
        ingress: 'chat',
        upstream: 'chat',
        routeQuality: 'lossless',
        e2eMs: 2,
      });
    }
    const s = m.snapshot();
    expect(s.requests).toBe(35);
    expect(s.byClientIngressUpstream.length).toBeLessThanOrEqual(10);
    expect(s.byClientIngressUpstream[0]?.client).toBe('c0');
    expect(s.byClientIngressUpstream[0]?.n).toBeGreaterThan(1);
  });

  it('水库容量有界：超容量后 n 仍为容量，分位数仍可算', () => {
    const m = new GatewayMetrics({ reservoirSize: 10 });
    for (let i = 1; i <= 50; i++) {
      m.observe({
        client: 'a',
        ingress: 'chat',
        upstream: 'chat',
        routeQuality: 'lossless',
        e2eMs: i,
      });
    }
    const d = m.snapshot().byRouteQuality.lossless!.e2e;
    expect(d.n).toBe(10); // 水库只留最近 10 个（41..50）
    expect(d.p50).toBe(45);
    expect(d.p95).toBe(50);
    expect(m.snapshot().byRouteQuality.lossless!.n).toBe(50);
  });

  it('KNOWN_LOSSES 覆盖 plan.ts 的 Loss 联合', () => {
    expect(KNOWN_LOSSES).toContain('signature');
    expect(KNOWN_LOSSES).toContain('sealed-reasoning');
    expect(KNOWN_LOSSES.length).toBe(8);
  });
});
