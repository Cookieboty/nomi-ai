jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  extractPrices,
  PRICE_SYNC_URL,
  PriceSync,
  readModelsDevCost,
} from '../../../src/usage/priceSync';
import { findPrice } from '../../../src/usage/pricing';
import { costUsd } from '../../../src/usage/pricing';

const cost = (input: number, output: number, extra: object = {}) => ({ input, output, ...extra });
const model = (id: string, c: unknown, extra: object = {}) => ({ id, name: id, cost: c, ...extra });

/** 一份够用的假 api.json：一手 + 转售商 + 各种坏数据 */
const fakeApi = () => {
  const filler: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) filler[`filler-${i}`] = model(`filler-${i}`, cost(1 + i, 2 + i));
  return {
    anthropic: {
      models: {
        'claude-opus-4-5': model(
          'claude-opus-4-5',
          cost(4, 20, { cache_read: 0.4, cache_write: 5 }),
        ),
        'claude-neg': model('claude-neg', cost(-1, 5)),
        'claude-nan': model('claude-nan', { input: 'x', output: 5 }),
        'claude-noout': model('claude-noout', { input: 1 }),
        'claude-badcache': model('claude-badcache', cost(1, 2, { cache_read: -0.1 })),
        'claude-old-thing': model('claude-old-thing', cost(9, 9), { status: 'deprecated' }),
        'claude-3-5-haiku-20241022': model('claude-3-5-haiku-20241022', cost(0.8, 4), {
          status: 'deprecated',
        }),
      },
    },
    openai: {
      models: {
        ...filler,
        'gpt-5.4': model(
          'gpt-5.4',
          cost(2.5, 15, {
            cache_read: 0.25,
            tiers: [
              { input: 5, output: 22.5, cache_read: 0.5, tier: { type: 'context', size: 272000 } },
            ],
            context_over_200k: { input: 5, output: 22.5 },
          }),
        ),
        'gpt-dup-tier': model(
          'gpt-dup-tier',
          cost(1, 2, {
            tiers: [
              { input: 2, output: 3, tier: { type: 'context', size: 100 } },
              { input: 3, output: 4, tier: { type: 'context', size: 100 } },
            ],
          }),
        ),
        'gpt-bad-tier': model(
          'gpt-bad-tier',
          cost(1, 2, { tiers: [{ input: -2, output: 3, tier: { type: 'context', size: 100 } }] }),
        ),
      },
    },
    zhipuai: {
      models: { 'glm-4.7': model('glm-4.7', cost(0.6, 2.2, { cache_read: 0.11, cache_write: 0 })) },
    },
    alibaba: {
      models: {
        'qwen3.7-flash': model(
          'qwen3.7-flash',
          cost(0.03, 0.13, {
            tiers: [
              { input: 0.2, output: 0.8, tier: { type: 'context', size: 256000 } },
              { input: 0.1, output: 0.4, tier: { type: 'context', size: 32000 } },
            ],
          }),
        ),
        // 转售：不能覆盖一手，也不收非千问
        'glm-4.7': model('glm-4.7', cost(99, 99)),
        'kimi-k3': model('kimi-k3', cost(99, 99)),
      },
    },
    openrouter: { models: { 'anthropic/claude-opus-4.5': model('x', cost(99, 99)) } },
  };
};

describe('extractPrices', () => {
  const r = extractPrices(fakeApi());
  const by = Object.fromEntries(r.entries.map((e) => [e.model, e]));

  it('只取一手提供商，转售商 / 阿里云转售的第三方模型不进来', () => {
    expect(by['claude-opus-4-5']).toMatchObject({
      input: 4,
      output: 20,
      cacheRead: 0.4,
      cacheWrite: 5,
    });
    expect(by['glm-4-7']).toMatchObject({ input: 0.6, cacheWrite: 0 }); // zhipuai 的，不是阿里的 99
    expect(by['kimi-k3']).toBeUndefined();
    expect(Object.keys(by).some((k) => k.includes('opus-4-5') && k !== 'claude-opus-4-5')).toBe(
      false,
    );
  });

  it('校验：负数 / 非数 / 缺 input·output / 缓存价非法 / 重复或非法 tier 都丢弃', () => {
    for (const k of [
      'claude-neg',
      'claude-nan',
      'claude-noout',
      'claude-badcache',
      'gpt-dup-tier',
      'gpt-bad-tier',
    ])
      expect(by[k]).toBeUndefined();
    expect(r.skipped).toBeGreaterThanOrEqual(6);
  });

  it('tiers：只留 context 档，按 size 升序；忽略 legacy context_over_200k', () => {
    expect(by['gpt-5.4'.replace('.', '-')]!.tiers).toEqual([
      { size: 272000, input: 5, output: 22.5, cacheRead: 0.5 },
    ]);
    expect(by['qwen3-7-flash']!.tiers!.map((t) => t.size)).toEqual([32000, 256000]);
  });

  it('deprecated：不覆盖内置（含前缀匹配）；内置里没有的才补进来', () => {
    expect(by['claude-3-5-haiku-20241022']).toBeUndefined(); // 内置有 claude-3-5-haiku
    expect(by['claude-old-thing']).toMatchObject({ input: 9 });
  });

  it('readModelsDevCost：0 合法；非对象返回 null', () => {
    expect(readModelsDevCost(cost(0, 0, { cache_write: 0 }))).toEqual({
      input: 0,
      output: 0,
      cacheWrite: 0,
    });
    expect(readModelsDevCost(null)).toBeNull();
    expect(readModelsDevCost(cost(1, 2, { tiers: 'x' }))).toBeNull();
    expect(
      readModelsDevCost(
        cost(1, 2, { tiers: [{ input: 1, output: 1, tier: { type: 'time', size: 5 } }] }),
      ),
    ).toBeNull();
  });
});

describe('PriceSync（mock fetch，不联网）', () => {
  const mk = (fetchImpl: jest.Mock, now = () => Date.parse('2026-10-16T08:00:00Z')) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-psync-'));
    return { root, sync: new PriceSync({ root, now, fetchImpl, logger: { warn: jest.fn() } }) };
  };
  const ok = (body: unknown, headers: Record<string, string> = { etag: '"e1"' }) =>
    new Response(JSON.stringify(body), { status: 200, headers });

  it('第一次：GET 固定地址，带 Accept-Encoding，不带 If-None-Match / 任何用量；存 etag 与覆盖层', async () => {
    const f = jest
      .fn()
      .mockResolvedValue(ok(fakeApi(), { etag: '"e1"', date: 'Fri, 16 Oct 2026 06:48:36 GMT' }));
    const { root, sync } = mk(f);
    const res = await sync.sync();
    expect(res).toMatchObject({ ok: true, status: 'updated' });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PRICE_SYNC_URL);
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ 'Accept-Encoding': 'br, gzip' });
    expect(init.headers).not.toHaveProperty('If-None-Match');
    expect(init.body).toBeUndefined();
    expect(sync.state()).toMatchObject({
      tableDate: '2026-10-16',
      fetchedAt: Date.parse('2026-10-16T08:00:00Z'),
    });
    expect(sync.state().count).toBeGreaterThan(10);
    // 落盘后重新载入（回退用的缓存）
    const again = new PriceSync({ root });
    expect(again.entries().length).toBe(sync.entries().length);
    // 文件权限仅当前用户（POSIX）
    if (process.platform !== 'win32')
      expect(fs.statSync(path.join(root, 'price-sync.json')).mode & 0o777).toBe(0o600);
  });

  it('第二次带 If-None-Match；304 不下载、保留缓存、只更新核对时间', async () => {
    let t = Date.parse('2026-10-16T08:00:00Z');
    const f = jest
      .fn()
      .mockResolvedValueOnce(ok(fakeApi()))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const { sync } = mk(f, () => t);
    await sync.sync();
    const before = sync.state();
    t += 3600_000;
    const res = await sync.sync();
    expect(res).toMatchObject({ ok: true, status: 'not-modified', count: before.count });
    expect((f.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ 'If-None-Match': '"e1"' });
    const after = sync.state();
    expect(after.fetchedAt).toBe(before.fetchedAt);
    expect(after.checkedAt).toBe(t);
    expect(sync.entries().length).toBe(before.count);
  });

  it('失败不动已有缓存：网络错误 / HTTP 500 / 坏 JSON / 条目太少', async () => {
    const f = jest
      .fn()
      .mockResolvedValueOnce(ok(fakeApi()))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response('x', { status: 500 }))
      .mockResolvedValueOnce(new Response('{bad', { status: 200 }))
      .mockResolvedValueOnce(ok({ openai: { models: { a: model('a', cost(1, 1)) } } }));
    const { sync } = mk(f);
    await sync.sync();
    const n = sync.entries().length;
    expect(await sync.sync()).toEqual({ ok: false, reason: 'network' });
    expect(await sync.sync()).toEqual({ ok: false, reason: 'http', httpStatus: 500 });
    expect(await sync.sync()).toEqual({ ok: false, reason: 'invalid' });
    expect(await sync.sync()).toEqual({ ok: false, reason: 'invalid' });
    expect(sync.entries().length).toBe(n);
  });

  it('并发点击只发一次请求；没有任何定时器 / 构造时不联网', async () => {
    let release!: (r: Response) => void;
    const f = jest.fn().mockReturnValue(new Promise<Response>((r) => (release = r)));
    const { sync } = mk(f);
    expect(f).not.toHaveBeenCalled();
    const a = sync.sync();
    expect(await sync.sync()).toEqual({ ok: false, reason: 'busy' });
    release(ok(fakeApi()));
    expect((await a).ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('损坏的缓存文件被忽略，回退内置（空覆盖层）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-psync-'));
    fs.writeFileSync(
      path.join(root, 'price-sync.json'),
      '{"entries":[{"model":"x","input":-1,"output":1}]}',
    );
    expect(new PriceSync({ root }).entries()).toEqual([]);
  });
});

describe('价格优先级与长上下文分档', () => {
  const synced = extractPrices(fakeApi()).entries;

  it('用户自定义 > 同步 > 内置；同步里没有的仍用内置（不删除内置）', () => {
    expect(findPrice('claude-opus-4-5-20251101')).toMatchObject({ source: 'builtin' });
    expect(findPrice('claude-opus-4-5-20251101', [], synced)).toMatchObject({
      source: 'sync',
      price: { input: 4, output: 20 },
    });
    expect(
      findPrice('claude-opus-4-5', [{ model: 'claude-opus-4-5', input: 1, output: 2 }], synced),
    ).toMatchObject({ source: 'custom', custom: true, price: { input: 1 } });
    // 内置有、同步没有
    expect(findPrice('gpt-4o', [], synced)).toMatchObject({ source: 'builtin' });
  });

  it('更具体的内置项不会被同步里更短的前缀盖掉', () => {
    const s = [{ model: 'gpt-4o', input: 1, output: 1 }];
    expect(findPrice('gpt-4o-2024-05-13', [], s)).toMatchObject({
      source: 'builtin',
      price: { input: 5, output: 15 },
    });
    expect(findPrice('gpt-4o-2024-08-06', [], s)).toMatchObject({ source: 'sync' });
  });

  it('按单次请求的提示词 token（含缓存）判断是否进入长上下文档', () => {
    const pr = findPrice('gpt-5.4')!.price; // 内置：≤272K 2.5/15，>272K 5/22.5，缓存读 0.25 → 0.5
    const M = 1_000_000;
    const at = { input: 100_000, output: M, cacheRead: 172_000, cacheWrite: 0 }; // 提示词 272000，不超过
    expect(costUsd(at, pr)).toBeCloseTo((100_000 * 2.5 + M * 15 + 172_000 * 0.25) / M, 9);
    const over = { input: 100_000, output: M, cacheRead: 172_001, cacheWrite: 0 }; // 272001 → 高档
    expect(costUsd(over, pr)).toBeCloseTo((100_000 * 5 + M * 22.5 + 172_001 * 0.5) / M, 9);
    // 两次各 200K 的请求不会因为日合计 400K 而升档
    const small = { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(costUsd(small, pr) * 2).toBeCloseTo((400_000 * 2.5) / M, 9);
  });

  it('多档：取已超过的最大档；档里没写的缓存价沿用基础价', () => {
    const pr = {
      input: 1,
      output: 2,
      cacheRead: 0.1,
      tiers: [
        { size: 32_000, input: 2, output: 4 },
        { size: 128_000, input: 3, output: 6, cacheRead: 0.3 },
      ],
    };
    const c = (n: number) => costUsd({ input: n, output: 0, cacheRead: 0, cacheWrite: 0 }, pr);
    expect(c(32_000)).toBeCloseTo(0.032, 9);
    expect(c(32_001)).toBeCloseTo((32_001 * 2) / 1e6, 9);
    expect(c(128_001)).toBeCloseTo((128_001 * 3) / 1e6, 9);
    expect(costUsd({ input: 0, output: 0, cacheRead: 40_000, cacheWrite: 0 }, pr)).toBeCloseTo(
      (40_000 * 0.1) / 1e6,
      9,
    );
  });

  it('快速模式与分档叠加', () => {
    const pr = findPrice('gpt-5.4')!.price;
    const r = { input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(costUsd({ ...r, fast: true }, pr)).toBeCloseTo(2 * costUsd(r, pr), 9);
  });
});
