/**
 * 候选冷却（docs/design/unified-gateway.md §11.1）。
 * 维度是 (供应商, Key, wire)：同一个 Key 在 Chat 端点可用、Anthropic 端点 401 很常见，额度也常按端点分开。
 * - 429 / 5xx / 529 / 首字节前超时 / 连接失败：冷却 60 秒；上游给了 Retry-After 时冷却 min(Retry-After, 10 分钟)
 * - 401 / 403：冷却 10 分钟
 * 冷却中的候选只是排到队尾（没有别的可用时照样尝试）；一次成功就清除。
 * 和 Learner 的短期压制（接口不存在，§7.4）分开记账。
 */
import type { Wire } from './ir';
import type { Candidate } from './route/resolve';

export const COOLDOWN_MS = 60_000;
export const AUTH_COOLDOWN_MS = 10 * 60_000;
export const MAX_RETRY_AFTER_MS = 10 * 60_000;

/** Key 状态变化，主进程据此在 Key 上记 lastError 并在界面标出（§11.1） */
export interface KeyStatusEvent {
  providerId: string;
  keyId: string;
  wire: Wire;
  status: 'auth' | 'ok' | 'limited';
  /** 上游原文（auth / limited） */
  error?: string;
  /** 冷却到期时间（毫秒时间戳，limited） */
  until?: number;
}

/** Retry-After：秒数或 HTTP 日期 → 距 now 的毫秒数；认不出返回 null */
export function parseRetryAfter(v: string | null | undefined, now: number): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - now);
}

/** 这次失败是否进入冷却：网络类失败（连接、超时）或上游状态 429 / 5xx / 401 / 403 */
export function coolsDown(f: { network?: boolean; upstreamStatus?: number }): boolean {
  if (f.network) return true;
  const s = f.upstreamStatus;
  return s !== undefined && (s === 429 || s >= 500 || s === 401 || s === 403);
}

type Reported = { status: 'auth' | 'limited'; error?: string };

const keyOf = (c: Pick<Candidate, 'provider' | 'key' | 'wire'>) =>
  `${c.provider.id}|${c.key.id}|${c.wire}`;

export class Cooldowns {
  private readonly until = new Map<string, number>();
  /** 已经报给主进程的非 ok 状态，用来只在转换时报 ok */
  private readonly reported = new Map<string, Reported>();

  constructor(
    private readonly onKeyStatus: (e: KeyStatusEvent) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  isCooling(c: Candidate): boolean {
    const u = this.until.get(keyOf(c));
    if (u === undefined) return false;
    if (u > this.now()) return true;
    this.until.delete(keyOf(c));
    return false;
  }

  /** 冷却到期时间；不在冷却中返回 null */
  coolingUntil(c: Candidate): number | null {
    return this.isCooling(c) ? this.until.get(keyOf(c))! : null;
  }

  /**
   * 记一次失败：status 是上游状态码（网络失败传 undefined），retryAfter 是上游的 Retry-After 原文。
   * 返回冷却到期时间。
   */
  fail(
    c: Candidate,
    f: { upstreamStatus?: number; retryAfter?: string | null; message?: string },
  ): number {
    const now = this.now();
    const s = f.upstreamStatus;
    const auth = s === 401 || s === 403;
    const ra = auth ? null : parseRetryAfter(f.retryAfter, now);
    const ms = auth
      ? AUTH_COOLDOWN_MS
      : ra !== null
        ? Math.min(ra, MAX_RETRY_AFTER_MS)
        : COOLDOWN_MS;
    const until = now + ms;
    const k = keyOf(c);
    this.until.set(k, until);
    const base = { providerId: c.provider.id, keyId: c.key.id, wire: c.wire };
    if (auth) {
      const prev = this.reported.get(k);
      if (prev?.status !== 'auth' || prev.error !== f.message) {
        this.reported.set(k, { status: 'auth', error: f.message });
        this.onKeyStatus({ ...base, status: 'auth', error: f.message, until });
      }
    } else if (s === 429) {
      this.reported.set(k, { status: 'limited', error: f.message });
      this.onKeyStatus({ ...base, status: 'limited', error: f.message, until });
    }
    return until;
  }

  /** 成功：清除冷却；之前报过 auth / limited 的报一次 ok */
  success(c: Candidate): void {
    const k = keyOf(c);
    this.until.delete(k);
    if (this.reported.delete(k))
      this.onKeyStatus({
        providerId: c.provider.id,
        keyId: c.key.id,
        wire: c.wire,
        status: 'ok',
      });
  }
}
