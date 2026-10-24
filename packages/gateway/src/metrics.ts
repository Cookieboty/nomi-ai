/**
 * 网关进程内实时指标（RoutePlan 生效后的 A+ / A2）：
 * - 按 client / ingress / upstream / routeQuality / loss 聚合请求数与 e2e（可选 ttft）分位数
 * - A2：按 (provider, keyId, upstreamWire) 记滚动健康样本，供候选排序降权（不删 Key、不永久禁用）
 * 重启清零；交叉维度与健康桶均有上限，避免无界增长。
 */
import type { QualityOutcome } from './quality';
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
  /** A2：胜出 / 最终上报的供应商（可选） */
  provider?: string;
  /** A2：Key id */
  keyId?: string;
  /** A2：上游协议（与 upstream 同义时可只传其一；优先 upstreamWire） */
  upstreamWire?: string;
  /** A2：请求结果，用于成功率 / auth·限流信号 */
  outcome?: QualityOutcome | string;
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

export interface DemoteHint {
  demote: boolean;
  until?: number;
  reason?: string;
}

export interface MetricsSnapshot {
  ok: true;
  since: number;
  requests: number;
  byRouteQuality: Partial<Record<RouteQuality, MetricsRouteQualityRow>>;
  byLoss: Partial<Record<string, number>>;
  byClientIngressUpstream: MetricsCrossRow[];
  /** A2：当前处于降权窗口内的 (provider|keyId|wire) 数量 */
  demotionsActive?: number;
}

/** 每个分位数水库最多保留的样本数 */
const DEFAULT_RESERVOIR = 512;
/** 交叉维度表最多行数（超出时丢掉 n 最小的） */
const DEFAULT_CROSS_CAP = 200;
/** A2：健康桶上限（provider|keyId|wire） */
const DEFAULT_HEALTH_CAP = 200;

// ---- A2 自适应降权阈值（克制：只重排，不删 Key）----
/** 窗口内至少这么多样本才评估降权，避免冷启动抖动 */
export const ADAPTIVE_MIN_SAMPLES = 10;
/** 成功率低于此 → 降权（含非 ok 的最终结果） */
export const ADAPTIVE_SUCCESS_RATE_FLOOR = 0.5;
/** routeQuality=degraded 占比高于此 → 降权 */
export const ADAPTIVE_DEGRADED_SHARE_CEIL = 0.4;
/** 触发后降权持续时长；成功观察会提前清除 */
export const ADAPTIVE_DEMOTE_MS = 5 * 60_000;
/** 每个 (provider,key,wire) 保留的最近样本数 */
export const ADAPTIVE_WINDOW_SIZE = 32;

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

/** 算作「成功」的 outcome（其余计失败；client-cancel 不计入健康窗口） */
const OK_OUTCOMES = new Set<string>(['ok']);
/** 直接触发降权的 auth / 限流类 outcome */
const AUTH_LIMITED = new Set<string>(['auth', 'rate-limit']);
/** 不计入健康样本（用户主动取消等） */
const SKIP_OUTCOMES = new Set<string>(['client-cancel']);

function clipStr(v: string, max: number): string {
  return v.length <= max ? v : v.slice(0, max);
}

/** NOMI_ADAPTIVE_ROUTE=0 关闭 A2 降权（观察与计数仍可写，排序不读） */
export function adaptiveRouteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NOMI_ADAPTIVE_ROUTE !== '0';
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

interface HealthSample {
  ok: boolean;
  degraded: boolean;
  authLimited: boolean;
}

interface HealthBucket {
  provider: string;
  keyId: string;
  wire: string;
  /** 环形最近样本 */
  samples: HealthSample[];
  i: number;
  filled: number;
  /** 降权到期时间（ms）；0 = 未降权 */
  demoteUntil: number;
  reason?: string;
}

export interface GatewayMetricsOptions {
  reservoirSize?: number;
  crossCap?: number;
  healthCap?: number;
  now?: () => number;
  /** 单测注入：覆盖 ADAPTIVE_* 阈值 */
  adaptive?: {
    minSamples?: number;
    successFloor?: number;
    degradedCeil?: number;
    demoteMs?: number;
    windowSize?: number;
  };
}

function healthKey(provider: string, keyId: string, wire: string): string {
  return `${provider}\0${keyId}\0${wire}`;
}

export class GatewayMetrics {
  readonly since: number;
  private requests = 0;
  private readonly byRQ = new Map<RouteQuality, Bucket>();
  private readonly byLoss = new Map<string, number>();
  private readonly cross = new Map<string, CrossBucket>();
  private readonly health = new Map<string, HealthBucket>();
  private readonly reservoirSize: number;
  private readonly crossCap: number;
  private readonly healthCap: number;
  private readonly now: () => number;
  private readonly minSamples: number;
  private readonly successFloor: number;
  private readonly degradedCeil: number;
  private readonly demoteMs: number;
  private readonly windowSize: number;

  constructor(opts: GatewayMetricsOptions = {}) {
    this.since = (opts.now ?? Date.now)();
    this.now = opts.now ?? Date.now;
    this.reservoirSize = opts.reservoirSize ?? DEFAULT_RESERVOIR;
    this.crossCap = opts.crossCap ?? DEFAULT_CROSS_CAP;
    this.healthCap = opts.healthCap ?? DEFAULT_HEALTH_CAP;
    this.minSamples = opts.adaptive?.minSamples ?? ADAPTIVE_MIN_SAMPLES;
    this.successFloor = opts.adaptive?.successFloor ?? ADAPTIVE_SUCCESS_RATE_FLOOR;
    this.degradedCeil = opts.adaptive?.degradedCeil ?? ADAPTIVE_DEGRADED_SHARE_CEIL;
    this.demoteMs = opts.adaptive?.demoteMs ?? ADAPTIVE_DEMOTE_MS;
    this.windowSize = opts.adaptive?.windowSize ?? ADAPTIVE_WINDOW_SIZE;
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
    const upstream = clipStr(e.upstream || e.upstreamWire || 'none', 32);
    const rqKey: RouteQuality | 'unknown' = rq ?? 'unknown';
    const key = `${client}\0${ingress}\0${upstream}\0${rqKey}`;
    let row = this.cross.get(key);
    if (!row) {
      if (this.cross.size >= this.crossCap) this.evictCross();
      // 淘汰后仍满（全是高流量行）：丢掉本次新键，避免无界
      if (this.cross.size >= this.crossCap) {
        this.recordHealthFromObserve(e, rq);
        return;
      }
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

    this.recordHealthFromObserve(e, rq);
  }

  /** 从 UsageEvent 字段记一条健康样本（缺 provider/key/wire 则跳过） */
  private recordHealthFromObserve(e: MetricsObserve, rq: RouteQuality | undefined): void {
    const provider = e.provider?.trim();
    const keyId = e.keyId?.trim();
    const wire = (e.upstreamWire || e.upstream || '').trim();
    if (!provider || !keyId || !wire || wire === 'none') return;
    const outcome = e.outcome;
    if (outcome && SKIP_OUTCOMES.has(outcome)) return;
    this.recordHealth({
      provider: clipStr(provider, 64),
      keyId: clipStr(keyId, 64),
      wire: clipStr(wire, 32),
      ok: !outcome || OK_OUTCOMES.has(outcome),
      degraded: rq === 'degraded',
      authLimited: Boolean(outcome && AUTH_LIMITED.has(outcome)),
    });
  }

  /**
   * 记一次 (provider,key,wire) 健康样本；成功清除降权，失败/degraded/auth 达阈值则进入降权窗。
   * 也可由 attemptsDetail 路径调用（与 observe 并列）。
   */
  recordHealth(s: {
    provider: string;
    keyId: string;
    wire: string;
    ok: boolean;
    degraded?: boolean;
    authLimited?: boolean;
  }): void {
    const k = healthKey(s.provider, s.keyId, s.wire);
    let b = this.health.get(k);
    if (!b) {
      if (this.health.size >= this.healthCap) this.evictHealth();
      if (this.health.size >= this.healthCap) return;
      b = {
        provider: s.provider,
        keyId: s.keyId,
        wire: s.wire,
        samples: new Array(this.windowSize),
        i: 0,
        filled: 0,
        demoteUntil: 0,
      };
      this.health.set(k, b);
    }
    b.samples[b.i] = {
      ok: s.ok,
      degraded: Boolean(s.degraded),
      authLimited: Boolean(s.authLimited),
    };
    b.i = (b.i + 1) % this.windowSize;
    if (b.filled < this.windowSize) b.filled++;

    if (s.ok && !s.degraded && !s.authLimited) {
      b.demoteUntil = 0;
      b.reason = undefined;
      return;
    }
    this.recomputeDemotion(b);
  }

  private recomputeDemotion(b: HealthBucket): void {
    const n = b.filled;
    if (n < this.minSamples) return;
    let ok = 0;
    let degraded = 0;
    let authLimited = 0;
    for (let i = 0; i < n; i++) {
      const s = b.samples[i]!;
      if (s.ok) ok++;
      if (s.degraded) degraded++;
      if (s.authLimited) authLimited++;
    }
    const successRate = ok / n;
    const degradedShare = degraded / n;
    let reason: string | undefined;
    if (authLimited > 0 && authLimited / n >= 0.2)
      reason = `auth/limited share ${(authLimited / n).toFixed(2)}`;
    else if (successRate < this.successFloor)
      reason = `successRate ${successRate.toFixed(2)} < ${this.successFloor}`;
    else if (degradedShare > this.degradedCeil)
      reason = `degradedShare ${degradedShare.toFixed(2)} > ${this.degradedCeil}`;
    if (!reason) return;
    b.demoteUntil = this.now() + this.demoteMs;
    b.reason = reason;
  }

  /**
   * A2：该候选是否应排到队尾（与冷却同哲学：仍可试，只是靠后）。
   * NOMI_ADAPTIVE_ROUTE=0 时恒为不降权。
   */
  shouldDemote(provider: string, keyId: string, wire: string): boolean {
    return this.demoteHint(provider, keyId, wire).demote;
  }

  demoteHint(provider: string, keyId: string, wire: string): DemoteHint {
    if (!adaptiveRouteEnabled()) return { demote: false };
    const b = this.health.get(healthKey(provider, keyId, wire));
    if (!b || b.demoteUntil <= this.now()) {
      if (b && b.demoteUntil && b.demoteUntil <= this.now()) {
        b.demoteUntil = 0;
        b.reason = undefined;
      }
      return { demote: false };
    }
    return { demote: true, until: b.demoteUntil, ...(b.reason ? { reason: b.reason } : {}) };
  }

  /** 丢掉 n 最小的一批，腾出约 10% 空位 */
  private evictCross(): void {
    const ranked = [...this.cross.entries()].sort(
      (a, b) => a[1].n - b[1].n || a[0].localeCompare(b[0]),
    );
    const drop = Math.max(1, Math.floor(this.crossCap * 0.1));
    for (let i = 0; i < drop && i < ranked.length; i++) this.cross.delete(ranked[i]![0]);
  }

  /** 健康桶：优先丢掉未降权且样本少的 */
  private evictHealth(): void {
    const now = this.now();
    const ranked = [...this.health.entries()].sort((a, b) => {
      const aHot = a[1].demoteUntil > now ? 1 : 0;
      const bHot = b[1].demoteUntil > now ? 1 : 0;
      if (aHot !== bHot) return aHot - bHot;
      return a[1].filled - b[1].filled || a[0].localeCompare(b[0]);
    });
    const drop = Math.max(1, Math.floor(this.healthCap * 0.1));
    for (let i = 0; i < drop && i < ranked.length; i++) this.health.delete(ranked[i]![0]);
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
    const now = this.now();
    let demotionsActive = 0;
    for (const b of this.health.values()) if (b.demoteUntil > now) demotionsActive++;
    return {
      ok: true,
      since: this.since,
      requests: this.requests,
      byRouteQuality,
      byLoss,
      byClientIngressUpstream,
      demotionsActive,
    };
  }
}
