/**
 * 额度缓存：按账号身份隔离 + 分层降级 + 60 秒节流。
 *
 * - 身份：非敏感指纹（见 quotaIdentity.ts）。指纹变了 = 换号，旧值立刻清掉，不会把上一个账号的数字展示给新账号；
 * - 降级：只有「暂时性失败」（超时、输出超限、网络、读不到额度字段等）才保留旧值并标 stale；
 *   「认证失效类」（没登录、登录过期、账号权限受限、改用了自定义供应商 / API）清掉旧值；
 * - 节流：同一个来源两次真实拉取（会拉起官方 CLI 的那种）至少间隔 TTL（60 秒），期间直接返回 throttled；
 *   同时只会有一个进行中的拉取。
 */
import type { QuotaReading } from './quota';

export const QUOTA_TTL_MS = 60_000;

export type AuthFailReason =
  'not-signed-in' | 'expired' | 'denied' | 'custom-provider' | 'api-account';

export type TransientReason =
  | 'timeout'
  | 'output-limit'
  | 'spawn-failed'
  | 'not-installed'
  | 'bad-output'
  | 'no-limits'
  | 'network'
  | 'unsupported';

export type FetchOutcome =
  | { kind: 'ok'; reading: QuotaReading; identity?: string | null }
  | { kind: 'transient'; reason: TransientReason }
  | { kind: 'auth'; reason: AuthFailReason };

/** 一次刷新的结果（给面板提示用；不含任何账号信息） */
export type RefreshResult =
  | { state: 'ok' }
  | { state: 'throttled' }
  /** 拉取期间被清空 / 换号作废：结果已丢弃，没有写入缓存 */
  | { state: 'superseded' }
  | { state: 'transient'; reason: TransientReason; stale: boolean }
  | { state: 'auth'; reason: AuthFailReason };

export class IdentityQuotaCache {
  private identity: string | null = null;
  private value: QuotaReading | null = null;
  private stale = false;
  private lastAttemptAt = 0;
  private inflight: Promise<RefreshResult> | null = null;
  /** 代际：clear / 换号 / 认证失效都会 +1。拉取开始时捕获，返回时对不上就丢弃，迟到的旧结果不能回写 */
  private gen = 0;
  private inflightGen = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = QUOTA_TTL_MS,
  ) {}

  get(): QuotaReading | null {
    return this.value ? { ...this.value, ...(this.stale ? { stale: true } : {}) } : null;
  }

  isStale(): boolean {
    return !!this.value && this.stale;
  }

  currentIdentity(): string | null {
    return this.identity;
  }

  clear(): void {
    this.gen++;
    this.value = null;
    this.stale = false;
    this.identity = null;
  }

  /** 已知身份变化（例如 `claude auth status` 的指纹）：换号清旧值 */
  observeIdentity(fp: string | null): boolean {
    if (!fp) return false;
    if (this.identity && this.identity !== fp) {
      this.gen++;
      this.value = null;
      this.stale = false;
      this.identity = fp;
      this.lastAttemptAt = 0; // 新账号不受旧账号的节流限制
      return true;
    }
    this.identity = fp;
    return false;
  }

  /** 距离下一次允许真实拉取还有多久（ms，0 = 现在就可以） */
  retryInMs(): number {
    return Math.max(0, this.lastAttemptAt + this.ttlMs - this.now());
  }

  refresh(fp: string | null, load: () => Promise<FetchOutcome>): Promise<RefreshResult> {
    this.observeIdentity(fp);
    // 只复用同一代际的进行中拉取：清空 / 换号之后的刷新不能拿到旧账号的 Promise
    if (this.inflight && this.inflightGen === this.gen) return this.inflight;
    if (this.retryInMs() > 0) return Promise.resolve({ state: 'throttled' });
    this.lastAttemptAt = this.now();
    const gen = this.gen;
    const p = (async (): Promise<RefreshResult> => {
      let out: FetchOutcome;
      try {
        out = await load();
      } catch {
        out = { kind: 'transient', reason: 'spawn-failed' };
      }
      // 开始之后被清空 / 换号过：成功、失败、认证失效一律不再回写（也不清新一代的值）
      if (gen !== this.gen) return { state: 'superseded' };
      if (out.kind === 'ok') {
        // 拉取结果自带身份（Codex）：和已有的不一致就先清旧值
        this.observeIdentity(out.identity ?? null);
        this.value = out.reading;
        this.stale = false;
        return { state: 'ok' };
      }
      if (out.kind === 'transient') {
        if (this.value) this.stale = true;
        return { state: 'transient', reason: out.reason, stale: !!this.value };
      }
      this.gen++;
      this.value = null;
      this.stale = false;
      this.identity = null;
      return { state: 'auth', reason: out.reason };
    })();
    this.inflight = p;
    this.inflightGen = gen;
    void p.finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    return p;
  }
}
