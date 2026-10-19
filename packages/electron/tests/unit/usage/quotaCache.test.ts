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

  describe('代际校验：清空 / 换号后迟到的结果不能回写', () => {
    const deferred = () => {
      let resolve!: (o: FetchOutcome) => void;
      const p = new Promise<FetchOutcome>((r) => {
        resolve = r;
      });
      return { p, resolve };
    };

    it('A 拉取中 clear，随后 A 成功：丢弃，缓存仍为空', async () => {
      const c = mk();
      const a = deferred();
      const pa = c.refresh('a', () => a.p);
      c.clear();
      a.resolve(ok(10, 'a'));
      expect(await pa).toEqual({ state: 'superseded' });
      expect(c.get()).toBeNull();
      expect(c.currentIdentity()).toBeNull();
    });

    it('A 拉取中换成 B（observeIdentity）再 A 成功：拒绝 A，不会把 A 装进 B 身份下', async () => {
      const c = mk();
      const a = deferred();
      const pa = c.refresh('a', () => a.p);
      c.observeIdentity('b');
      a.resolve(ok(10));
      expect(await pa).toEqual({ state: 'superseded' });
      expect(c.get()).toBeNull();
      expect(c.currentIdentity()).toBe('b');
    });

    it('A → B → B 成功 → A 成功：B 的值保留；B 刷新不复用 A 的 Promise', async () => {
      const c = mk();
      const a = deferred();
      const b = deferred();
      const fa = jest.fn(() => a.p);
      const fb = jest.fn(() => b.p);
      const pa = c.refresh('a', fa);
      const pb = c.refresh('b', fb);
      expect(fb).toHaveBeenCalledTimes(1);
      b.resolve(ok(22));
      expect(await pb).toEqual({ state: 'ok' });
      a.resolve(ok(99));
      expect(await pa).toEqual({ state: 'superseded' });
      expect(c.get()!.windows[0]!.usedPercent).toBe(22);
      expect(c.currentIdentity()).toBe('b');
    });

    it('A 迟到的失败 / 认证失效也不影响新一代的值', async () => {
      const c = mk();
      const a = deferred();
      const pa = c.refresh('a', () => a.p);
      const pb = c.refresh('b', async () => ok(7));
      await pb;
      a.resolve({ kind: 'auth', reason: 'expired' });
      expect(await pa).toEqual({ state: 'superseded' });
      expect(c.get()!.windows[0]!.usedPercent).toBe(7);
      const a2 = deferred();
      const pa2 = (() => {
        t += 120_000;
        return c.refresh('b', () => a2.p);
      })();
      c.observeIdentity('c');
      a2.resolve({ kind: 'transient', reason: 'timeout' });
      expect(await pa2).toEqual({ state: 'superseded' });
      expect(c.isStale()).toBe(false);
    });

    it('clear 后立即新刷新：旧 Promise 的 finally 不清掉新的 inflight', async () => {
      const c = mk();
      const a = deferred();
      const pa = c.refresh('a', () => a.p);
      c.clear();
      // 不推进时间：清空要重置节流，紧接着的刷新必须真的发起（#45）
      const b = deferred();
      const fb = jest.fn(() => b.p);
      const pb = c.refresh('a', fb);
      a.resolve(ok(1));
      await pa;
      // 旧结果已结束，新拉取仍在进行：再次刷新复用它而不是再起一个
      const pb2 = c.refresh('a', fb);
      b.resolve(ok(2));
      expect(await pb).toEqual({ state: 'ok' });
      expect(await pb2).toEqual({ state: 'ok' });
      expect(fb).toHaveBeenCalledTimes(1);
      expect(c.get()!.windows[0]!.usedPercent).toBe(2);
    });
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
