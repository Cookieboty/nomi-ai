/**
 * 重连策略（docs/design/unified-gateway.md §11.1）：临时性错误先在同一个 Key 上退避重连，
 * 重连够了换 Key，同一家累计失败够了换供应商（同一个模型的下一家，§7.2）。
 *
 * - 同一个 Key：最多重连 KEY_RETRIES 次；这家只有一个 Key 时最多 SINGLE_KEY_RETRIES 次；
 * - 同一家供应商累计失败 PROVIDER_MAX_FAILURES 次：放弃它剩下的 Key，直接换下一家；
 * - 退避：指数增长 + 随机抖动（与 Codex / Claude Code 一致），上游给了 Retry-After 按它（有上限）；
 * - 只有临时性错误重连：连接失败 / 超时、408、429、500、502、503、504、529。
 *   401 / 403（Key 无效）直接换 Key，404（这家没有这个模型）直接换供应商，其余 4xx 不重试。
 *
 * Go 版：apps/desktop-go/internal/gateway/server/retry.go。
 */

/** 同一个 Key 最多重连几次（不含第一次） */
export const KEY_RETRIES = 3;
/** 供应商只有一个 Key 时，这个 Key 最多重连几次 */
export const SINGLE_KEY_RETRIES = 5;
/** 同一家供应商累计失败几次就换下一家 */
export const PROVIDER_MAX_FAILURES = 10;
/** 每个请求的尝试总数上限（只防失控；正常由上面三条与首字节预算决定） */
export const MAX_TOTAL_ATTEMPTS = 30;
/** 退避的起点与上限 */
export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 8_000;
/** Retry-After 最多等多久 */
export const RETRY_AFTER_MAX_MS = 30_000;

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/** 这次失败是不是临时性的（值得在同一个 Key 上退避重连） */
export function isTransientFailure(f: {
  status: number;
  upstreamStatus?: number;
  network?: boolean;
  errorKind?: string;
}): boolean {
  // 本地并发 / 每分钟限额排队超时：已经等过了，换下一个候选
  if (f.errorKind === 'local-limit') return false;
  if (f.network) return true;
  return TRANSIENT_STATUS.has(f.upstreamStatus ?? f.status);
}

/** 这个 Key 最多重连几次：所在供应商（在这次的候选里）只有一个 Key 时更多 */
export function keyRetryLimit(keysOfProvider: number): number {
  return keysOfProvider <= 1 ? SINGLE_KEY_RETRIES : KEY_RETRIES;
}

/** Retry-After：秒数或 HTTP 日期；解析不了返回 undefined */
export function retryAfterMs(raw: string | undefined, now = Date.now()): number | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * 第 retry 次重连（从 1 开始）前等多久：base × 2^(retry-1)，封顶 RETRY_MAX_DELAY_MS，±20% 抖动；
 * 上游给了 Retry-After 时用它（封顶 RETRY_AFTER_MAX_MS）。base 为 0 时不等（测试）。
 */
export function retryDelayMs(
  retry: number,
  opts: { retryAfter?: string; baseMs?: number; random?: () => number; now?: number } = {},
): number {
  const base = opts.baseMs ?? RETRY_BASE_DELAY_MS;
  if (base <= 0) return 0;
  const hinted = retryAfterMs(opts.retryAfter, opts.now);
  if (hinted !== undefined) return Math.min(hinted, RETRY_AFTER_MAX_MS);
  const exp = Math.min(base * 2 ** Math.max(0, retry - 1), RETRY_MAX_DELAY_MS);
  const jitter = 0.8 + 0.4 * (opts.random ?? Math.random)();
  return Math.round(exp * jitter);
}

/** 可中止的等待；等待期间每隔 tickMs 调一次 onTick（流式请求给客户端发保活）。被中止返回 false */
export function waitRetry(
  ms: number,
  signal: AbortSignal,
  onTick?: () => void,
  tickMs = 5_000,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const tick = onTick ? setInterval(onTick, tickMs) : undefined;
    const done = (ok: boolean) => {
      clearTimeout(timer);
      if (tick) clearInterval(tick);
      signal.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
