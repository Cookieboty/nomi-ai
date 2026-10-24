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
      demotionsActive: 0,
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

describe('GatewayMetrics A2 adaptive demotion', () => {
  const key = { provider: 'p', keyId: 'k1', upstreamWire: 'chat' as const };

  it('样本不足 MIN 不降权', () => {
    const m = new GatewayMetrics({ now: () => 1000 });
    for (let i = 0; i < 9; i++) {
      m.observe({
        client: 'c',
        ingress: 'chat',
        ...key,
        upstream: 'chat',
        outcome: 'upstream-5xx',
        routeQuality: 'good',
      });
    }
    expect(m.shouldDemote('p', 'k1', 'chat')).toBe(false);
    expect(m.snapshot().demotionsActive).toBe(0);
  });

  it('成功率过低 → 降权；成功清除', () => {
    let t = 1_000;
    const m = new GatewayMetrics({
      now: () => t,
      adaptive: { minSamples: 10, successFloor: 0.5, demoteMs: 60_000 },
    });
    for (let i = 0; i < 10; i++) {
      m.observe({
        client: 'c',
        ingress: 'chat',
        provider: 'p',
        keyId: 'k1',
        upstream: 'chat',
        upstreamWire: 'chat',
        outcome: i < 2 ? 'ok' : 'upstream-5xx',
        routeQuality: 'good',
      });
    }
    expect(m.shouldDemote('p', 'k1', 'chat')).toBe(true);
    expect(m.demoteHint('p', 'k1', 'chat').reason).toMatch(/successRate/);
    expect(m.snapshot().demotionsActive).toBe(1);

    m.observe({
      client: 'c',
      ingress: 'chat',
      provider: 'p',
      keyId: 'k1',
      upstream: 'chat',
      upstreamWire: 'chat',
      outcome: 'ok',
      routeQuality: 'lossless',
    });
    expect(m.shouldDemote('p', 'k1', 'chat')).toBe(false);
    expect(m.snapshot().demotionsActive).toBe(0);

    // 到期后也不再降权
    for (let i = 0; i < 10; i++) {
      m.observe({
        client: 'c',
        ingress: 'chat',
        provider: 'p',
        keyId: 'k2',
        upstream: 'chat',
        upstreamWire: 'chat',
        outcome: 'upstream-5xx',
        routeQuality: 'good',
      });
    }
    expect(m.shouldDemote('p', 'k2', 'chat')).toBe(true);
    t += 60_001;
    expect(m.shouldDemote('p', 'k2', 'chat')).toBe(false);
  });

  it('degraded 占比过高 → 降权', () => {
    const m = new GatewayMetrics({
      now: () => 1,
      adaptive: { minSamples: 10, degradedCeil: 0.4 },
    });
    // 末尾不能是「纯成功」——单次成功会清除降权（与 Cooldowns.success 同哲学）
    for (let i = 0; i < 10; i++) {
      m.observe({
        client: 'c',
        ingress: 'chat',
        provider: 'p',
        keyId: 'kd',
        upstream: 'messages',
        upstreamWire: 'messages',
        outcome: i < 5 ? 'ok' : 'upstream-5xx',
        routeQuality: i < 5 ? 'degraded' : 'good',
      });
    }
    expect(m.shouldDemote('p', 'kd', 'messages')).toBe(true);
    expect(m.demoteHint('p', 'kd', 'messages').reason).toMatch(/degradedShare/);
  });

  it('NOMI_ADAPTIVE_ROUTE=0 关闭排序降权', () => {
    const prev = process.env.NOMI_ADAPTIVE_ROUTE;
    process.env.NOMI_ADAPTIVE_ROUTE = '0';
    try {
      const m = new GatewayMetrics({ now: () => 1, adaptive: { minSamples: 10 } });
      for (let i = 0; i < 10; i++) {
        m.observe({
          client: 'c',
          ingress: 'chat',
          provider: 'p',
          keyId: 'k0',
          upstream: 'chat',
          upstreamWire: 'chat',
          outcome: 'upstream-5xx',
        });
      }
      // 内部仍可记 demoteUntil，但 shouldDemote 对外关闭
      expect(m.shouldDemote('p', 'k0', 'chat')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NOMI_ADAPTIVE_ROUTE;
      else process.env.NOMI_ADAPTIVE_ROUTE = prev;
    }
  });

  it('recordHealth：auth 占比触发降权', () => {
    const m = new GatewayMetrics({ now: () => 1, adaptive: { minSamples: 10 } });
    for (let i = 0; i < 10; i++) {
      m.recordHealth({
        provider: 'p',
        keyId: 'ka',
        wire: 'chat',
        ok: false,
        authLimited: i < 3,
      });
    }
    expect(m.shouldDemote('p', 'ka', 'chat')).toBe(true);
    expect(m.demoteHint('p', 'ka', 'chat').reason).toMatch(/auth/);
  });
});
