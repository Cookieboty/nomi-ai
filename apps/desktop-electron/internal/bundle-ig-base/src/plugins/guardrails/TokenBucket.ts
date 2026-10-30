/**
 * 简易 token bucket —— 用于 RateLimit 拦截器。
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(tokensPerMinute: number, burst: number) {
    this.capacity = Math.max(burst, 1);
    this.tokens = this.capacity;
    this.lastRefillMs = Date.now();
    this.refillPerMs = tokensPerMinute / 60_000;
  }

  tryConsume(cost = 1, now = Date.now()): boolean {
    const elapsed = now - this.lastRefillMs;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefillMs = now;
    }
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  get available(): number {
    return this.tokens;
  }
}
