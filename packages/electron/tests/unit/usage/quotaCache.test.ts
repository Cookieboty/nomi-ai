import type { QuotaReading } from '../../../src/usage/quota';
import { IdentityQuotaCache, type FetchOutcome } from '../../../src/usage/quotaCache';
import { fingerprint } from '../../../src/usage/quotaIdentity';

const reading = (pct: number, at = 0): QuotaReading => ({
  windows: [{ id: 'five_hour', usedPercent: pct }],
  updatedAt: at,
});
const ok = (pct: number, identity?: string): FetchOutcome => ({
  kind: 'ok',
  reading: reading(pct),
  ...(identity ? { identity } : {}),
});

describe('IdentityQuotaCache：身份隔离 / 分层降级 / 60 秒节流', () => {
  let t = 1_000_000;
  const mk = () => new IdentityQuotaCache(() => t, 60_000);
  beforeEach(() => {
    t = 1_000_000;
  });

  it('成功后可读；TTL 内第二次刷新直接 throttled，不再拉取', async () => {
    const c = mk();
    const f = jest.fn(async () => ok(10));
    expect(await c.refresh('a', f)).toEqual({ state: 'ok' });
    expect(c.get()!.windows[0]!.usedPercent).toBe(10);
    t += 30_000;
    expect(await c.refresh('a', f)).toEqual({ state: 'throttled' });
    expect(f).toHaveBeenCalledTimes(1);
    expect(c.retryInMs()).toBe(30_000);
    t += 30_000;
    expect(await c.refresh('a', f)).toEqual({ state: 'ok' });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('失败的拉取同样占用节流窗口（不会因为一直失败而反复拉起 CLI）', async () => {
    const c = mk();
    const f = jest.fn(async (): Promise<FetchOutcome> => ({
      kind: 'transient',
      reason: 'timeout',
    }));
    await c.refresh('a', f);
    await c.refresh('a', f);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('同时只有一个进行中的拉取', async () => {
    const c = mk();
    let release!: () => void;
    const f = jest.fn(
      () =>
        new Promise<FetchOutcome>((r) => {
          release = () => r(ok(5));
        }),
    );
    const p1 = c.refresh('a', f);
    const p2 = c.refresh('a', f);
    release();
    expect(await p1).toEqual(await p2);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('暂时性失败：保留旧值并标 stale；之后成功恢复', async () => {
    const c = mk();
    await c.refresh('a', async () => ok(10));
    t += 61_000;
    const r = await c.refresh('a', async () => ({ kind: 'transient', reason: 'timeout' }));
    expect(r).toEqual({ state: 'transient', reason: 'timeout', stale: true });
    expect(c.get()).toMatchObject({ stale: true });
    expect(c.get()!.windows[0]!.usedPercent).toBe(10);
    t += 61_000;
    await c.refresh('a', async () => ok(20));
    expect(c.get()!.stale).toBeUndefined();
    expect(c.get()!.windows[0]!.usedPercent).toBe(20);
  });

  it('没有旧值时的暂时性失败：stale=false，值仍为空', async () => {
    const c = mk();
    const r = await c.refresh('a', async () => ({ kind: 'transient', reason: 'no-limits' }));
    expect(r).toEqual({ state: 'transient', reason: 'no-limits', stale: false });
    expect(c.get()).toBeNull();
  });

  it('认证失效类：清除旧值（不显示 stale）', async () => {
    const c = mk();
    await c.refresh('a', async () => ok(10));
    t += 61_000;
    const r = await c.refresh('a', async () => ({ kind: 'auth', reason: 'expired' }));
    expect(r).toEqual({ state: 'auth', reason: 'expired' });
    expect(c.get()).toBeNull();
    expect(c.currentIdentity()).toBeNull();
  });

  it('换号（已知指纹变化）：旧账号的值立刻清掉，且不受旧账号节流限制', async () => {
    const c = mk();
    await c.refresh('acct-a', async () => ok(80));
    expect(c.get()!.windows[0]!.usedPercent).toBe(80);
    const failing = jest.fn(async (): Promise<FetchOutcome> => ({
      kind: 'transient',
      reason: 'timeout',
    }));
    // 30 秒后换成 B：即使拉取失败，也不会把 A 的 80% 展示给 B
    t += 30_000;
    const r = await c.refresh('acct-b', failing);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ state: 'transient', stale: false });
    expect(c.get()).toBeNull();
  });

  it('换号（拉取结果自带身份，如 Codex）：先清旧值再写新值', async () => {
    const c = mk();
    await c.refresh(null, async () => ok(80, 'fp-a'));
    t += 61_000;
    await c.refresh(null, async () => ok(5, 'fp-b'));
    expect(c.currentIdentity()).toBe('fp-b');
    expect(c.get()!.windows[0]!.usedPercent).toBe(5);
    // 换号后失败：不会回到 A 的值
    t += 61_000;
    await c.refresh(null, async () => ({ kind: 'transient', reason: 'timeout' }));
    expect(c.get()!.windows[0]!.usedPercent).toBe(5);
  });

  it('fetch 抛异常按暂时性失败处理', async () => {
    const c = mk();
    const r = await c.refresh('a', async () => {
      throw new Error('boom');
    });
    expect(r).toMatchObject({ state: 'transient', reason: 'spawn-failed' });
  });
});

describe('fingerprint：非敏感指纹', () => {
  it('同输入同盐稳定；换盐 / 换账号不同；不含明文；空身份返回 null', () => {
    const a = fingerprint('salt1', ['me@example.com', 'org-1', 'max'])!;
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(fingerprint('salt1', ['me@example.com', 'org-1', 'max']));
    expect(a).not.toBe(fingerprint('salt2', ['me@example.com', 'org-1', 'max']));
    expect(a).not.toBe(fingerprint('salt1', ['you@example.com', 'org-1', 'max']));
    expect(a).not.toContain('example');
    expect(fingerprint('salt1', [null, 'org'])).toBeNull();
    expect(fingerprint('salt1', ['', 'org'])).toBeNull();
  });
});
