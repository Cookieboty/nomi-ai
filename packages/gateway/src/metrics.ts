/**
 * 网关进程内实时指标（RoutePlan 生效后的 A+）：按 client / ingress / upstream / routeQuality / loss
 * 聚合请求数与 e2e（可选 ttft）分位数。重启清零；交叉维度表只保留 top K，样本库有上限，避免无界增长。
 */
import type { Loss } from './route/plan';

export type RouteQuality = 'lossless' | 'good' | 'degraded';

export interface MetricsObserve {
  client: string;
  ingress: string;
  /** 上游协议（没走到上游时没有） */
  upstream?: string;
  routeQuality?: RouteQuality;
  losses?: readonly Loss[] | readonly string[];
  /** 相对 startedAt 的 e2e（ms） */
  e2eMs?: number;
  /** 相对 startedAt 的 TTFT（ms）；只有成功流式等有首字的才有 */
  ttftMs?: number;
}

export interface MetricsDist {
  n: number;
  p50?: number;
  p95?: number;
}

export interface MetricsRouteQualityRow {
  n: number;
  e2e: MetricsDist;
  ttft?: MetricsDist;
}

export interface MetricsCrossRow {
  client: string;
  ingress: string;
  upstream: string;
  routeQuality: RouteQuality | 'unknown';
  n: number;
  e2e: MetricsDist;
  losses: Partial<Record<string, number>>;
}

export interface MetricsSnapshot {
  ok: true;
  since: number;
  requests: number;
  byRouteQuality: Partial<Record<RouteQuality, MetricsRouteQualityRow>>;
  byLoss: Partial<Record<string, number>>;
  byClientIngressUpstream: MetricsCrossRow[];
}

/** 每个分位数水库最多保留的样本数 */
const DEFAULT_RESERVOIR = 512;
/** 交叉维度表最多行数（超出时丢掉 n 最小的） */
const DEFAULT_CROSS_CAP = 200;

/** 已知 Loss（非法值不进 byLoss，避免任意字符串撑爆） */
export const KNOWN_LOSSES: readonly Loss[] = [
  'sealed-reasoning',
  'signature',
  'thought-signature',
  'cache-control',
  'freeform-tools',
  'images',
  'passthrough',
  'reasoning-control',
];

const LOSS_SET = new Set<string>(KNOWN_LOSSES);
const RQ_SET = new Set<string>(['lossless', 'good', 'degraded']);

function clipStr(v: string, max: number): string {
  return v.length <= max ? v : v.slice(0, max);
}

/** 环形水库：满了覆盖最旧；分位数对当前有效样本排序后取最近秩 */
class Reservoir {
  private readonly buf: Float64Array;
  private i = 0;
  private filled = 0;
  constructor(capacity: number) {
    this.buf = new Float64Array(Math.max(1, capacity));
  }
  push(v: number): void {
    if (!Number.isFinite(v) || v < 0) return;
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled++;
  }
  dist(): MetricsDist {
    const n = this.filled;
    if (!n) return { n: 0 };
    const xs = Array.from(this.buf.subarray(0, n));
    xs.sort((a, b) => a - b);
    const at = (p: number) => xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]!;
    return { n, p50: at(0.5), p95: at(0.95) };
  }
}

interface Bucket {
  n: number;
  e2e: Reservoir;
  ttft: Reservoir;
}

interface CrossBucket {
  client: string;
  ingress: string;
  upstream: string;
  routeQuality: RouteQuality | 'unknown';
  n: number;
  e2e: Reservoir;
  losses: Map<string, number>;
}

export interface GatewayMetricsOptions {
  reservoirSize?: number;
  crossCap?: number;
  now?: () => number;
}

export class GatewayMetrics {
  readonly since: number;
  private requests = 0;
  private readonly byRQ = new Map<RouteQuality, Bucket>();
  private readonly byLoss = new Map<string, number>();
  private readonly cross = new Map<string, CrossBucket>();
  private readonly reservoirSize: number;
  private readonly crossCap: number;

  constructor(opts: GatewayMetricsOptions = {}) {
    this.since = (opts.now ?? Date.now)();
    this.reservoirSize = opts.reservoirSize ?? DEFAULT_RESERVOIR;
    this.crossCap = opts.crossCap ?? DEFAULT_CROSS_CAP;
  }

  private bucket(): Bucket {
    return {
      n: 0,
      e2e: new Reservoir(this.reservoirSize),
      ttft: new Reservoir(this.reservoirSize),
    };
  }

  observe(e: MetricsObserve): void {
    this.requests++;
    const rq = e.routeQuality && RQ_SET.has(e.routeQuality) ? e.routeQuality : undefined;
    const losses = (e.losses ?? []).filter(
      (l): l is string => typeof l === 'string' && LOSS_SET.has(l),
    );
    if (rq) {
      let b = this.byRQ.get(rq);
      if (!b) {
        b = this.bucket();
        this.byRQ.set(rq, b);
      }
      b.n++;
      if (e.e2eMs !== undefined) b.e2e.push(e.e2eMs);
      if (e.ttftMs !== undefined) b.ttft.push(e.ttftMs);
    }
    for (const l of losses) this.byLoss.set(l, (this.byLoss.get(l) ?? 0) + 1);

    const client = clipStr(e.client || 'unknown', 32);
    const ingress = clipStr(e.ingress || 'unknown', 32);
    const upstream = clipStr(e.upstream || 'none', 32);
    const rqKey: RouteQuality | 'unknown' = rq ?? 'unknown';
    const key = `${client}\0${ingress}\0${upstream}\0${rqKey}`;
    let row = this.cross.get(key);
    if (!row) {
      if (this.cross.size >= this.crossCap) this.evictCross();
      // 淘汰后仍满（全是高流量行）：丢掉本次新键，避免无界
      if (this.cross.size >= this.crossCap) return;
      row = {
        client,
        ingress,
        upstream,
        routeQuality: rqKey,
        n: 0,
        e2e: new Reservoir(this.reservoirSize),
        losses: new Map(),
      };
      this.cross.set(key, row);
    }
    row.n++;
    if (e.e2eMs !== undefined) row.e2e.push(e.e2eMs);
    for (const l of losses) row.losses.set(l, (row.losses.get(l) ?? 0) + 1);
  }

  /** 丢掉 n 最小的一批，腾出约 10% 空位 */
  private evictCross(): void {
    const ranked = [...this.cross.entries()].sort(
      (a, b) => a[1].n - b[1].n || a[0].localeCompare(b[0]),
    );
    const drop = Math.max(1, Math.floor(this.crossCap * 0.1));
    for (let i = 0; i < drop && i < ranked.length; i++) this.cross.delete(ranked[i]![0]);
  }

  snapshot(): MetricsSnapshot {
    const byRouteQuality: MetricsSnapshot['byRouteQuality'] = {};
    for (const q of ['lossless', 'good', 'degraded'] as const) {
      const b = this.byRQ.get(q);
      if (!b) continue;
      const e2e = b.e2e.dist();
      const ttft = b.ttft.dist();
      byRouteQuality[q] = {
        n: b.n,
        e2e,
        ...(ttft.n ? { ttft } : {}),
      };
    }
    const byLoss: MetricsSnapshot['byLoss'] = {};
    for (const [k, n] of [...this.byLoss.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    ))
      byLoss[k] = n;
    const byClientIngressUpstream = [...this.cross.values()]
      .sort((a, b) => b.n - a.n || a.client.localeCompare(b.client))
      .map((r) => {
        const losses: Partial<Record<string, number>> = {};
        for (const [k, n] of [...r.losses.entries()].sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        ))
          losses[k] = n;
        return {
          client: r.client,
          ingress: r.ingress,
          upstream: r.upstream,
          routeQuality: r.routeQuality,
          n: r.n,
          e2e: r.e2e.dist(),
          losses,
        };
      });
    return {
      ok: true,
      since: this.since,
      requests: this.requests,
      byRouteQuality,
      byLoss,
      byClientIngressUpstream,
    };
  }
}
