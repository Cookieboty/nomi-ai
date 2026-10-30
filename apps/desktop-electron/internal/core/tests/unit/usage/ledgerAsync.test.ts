jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRecordingAppEvents } from '../../../src/core/appEvents';
import type { UsageRecord } from '../../../src/usage/types';
import { UsageLedger } from '../../../src/usage/UsageLedger';
import { UsageService } from '../../../src/usage/UsageService';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-async-'));
const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  key: 'k1',
  ts: 1_000_000,
  source: 'claude',
  via: 'log',
  model: 'm',
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  ...over,
});
const writeLedger = (root: string, recs: UsageRecord[]) =>
  fs.writeFileSync(
    path.join(root, 'ledger.jsonl'),
    recs.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
const fileLines = (root: string) =>
  fs
    .readFileSync(path.join(root, 'ledger.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as UsageRecord);
/** 后台载入：syncLoadMaxBytes 0 让任何非空账本都走异步路径 */
const asyncLedger = (
  root: string,
  extra: Partial<ConstructorParameters<typeof UsageLedger>[0]> = {},
) => new UsageLedger({ root, flushMs: 60_000, syncLoadMaxBytes: 0, ...extra });

describe('UsageLedger：后台载入', () => {
  it('大账本不在构造时读完；whenReady 之后数据完整，游标一并载入', async () => {
    const root = tmp();
    writeLedger(root, [
      rec({ key: 'a', ts: 1 }),
      rec({ key: 'b', ts: 2 }),
      rec({ key: 'a', ts: 1, output: 9 }),
    ]);
    fs.writeFileSync(
      path.join(root, 'cursors.json'),
      JSON.stringify({ '/log': { offset: 3, size: 3, mtimeMs: 1 } }),
    );
    const onLoaded = jest.fn();
    const l = asyncLedger(root, { onLoaded });
    expect(l.isLoaded()).toBe(false);
    expect(l.size()).toBe(0);
    const v0 = l.version();
    await l.whenReady();
    expect(l.isLoaded()).toBe(true);
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(l.version()).toBeGreaterThan(v0); // 派生缓存随载入失效
    expect(l.all().map((r) => [r.key, r.output])).toEqual([
      ['a', 9],
      ['b', 1],
    ]);
    expect(l.cursor('/log')?.offset).toBe(3);
  });

  it('小账本仍同步载入（构造完立即可查）', async () => {
    const root = tmp();
    writeLedger(root, [rec({ key: 'a' })]);
    const l = new UsageLedger({ root });
    expect(l.isLoaded()).toBe(true);
    expect(l.size()).toBe(1);
    await expect(l.whenReady()).resolves.toBeUndefined();
  });

  it('载入期间的写入不丢、不重复：与磁盘记录按 upsert 口径合并，落盘后重开一致', async () => {
    const root = tmp();
    writeLedger(root, [rec({ key: 'a', output: 5 }), rec({ key: 'b', ts: 2_000_000 })]);
    const l = asyncLedger(root);
    // 磁盘上 a 的 output 更大：载入期间这条更小的不能把它盖掉；cacheRead 是新增的要保留
    expect(l.upsert(rec({ key: 'a', output: 3, cacheRead: 10 }))).toBe(true);
    expect(l.upsert(rec({ key: 'c', ts: 3_000_000 }))).toBe(true);
    l.flush(); // 载入期间同步追加：只写记录，不碰游标
    await l.whenReady();
    expect(l.size()).toBe(3);
    expect(l.get('a')).toMatchObject({ output: 5, cacheRead: 10 });
    expect(l.persistState().pendingRecords).toBe(1); // 合并后的 a 要再写一行盖过载入期间那一行
    l.flush();
    const re = new UsageLedger({ root });
    expect(re.size()).toBe(3);
    expect(re.get('a')).toMatchObject({ output: 5, cacheRead: 10 });
    expect(re.all().map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('载入期间一键清空：磁盘旧记录作废，清空后写入的保留', async () => {
    const root = tmp();
    writeLedger(root, [rec({ key: 'old1' }), rec({ key: 'old2' })]);
    const l = asyncLedger(root);
    l.upsert(rec({ key: 'before-clear' }));
    l.clear();
    l.upsert(rec({ key: 'after-clear' }));
    await l.whenReady();
    expect(l.all().map((r) => r.key)).toEqual(['after-clear']);
    l.flush();
    expect(new UsageLedger({ root }).all().map((r) => r.key)).toEqual(['after-clear']);
  });

  it('载入期间的保留期清理推迟到载入完成后执行', async () => {
    const now = 400 * 86_400_000;
    const root = tmp();
    writeLedger(root, [
      rec({ key: 'old', ts: now - 100 * 86_400_000 }),
      rec({ key: 'new', ts: now - 10 * 86_400_000 }),
    ]);
    const l = asyncLedger(root, { now: () => now });
    expect(l.prune('90d')).toBe(0);
    await l.whenReady();
    expect(l.all().map((r) => r.key)).toEqual(['new']);
    await l.compact(); // 等清理触发的压缩写完
    expect(fileLines(root).map((r) => r.key)).toEqual(['new']);
  });

  it('载入期间游标：同步落盘不写游标文件（磁盘游标还没并入），载入后合并', async () => {
    const root = tmp();
    writeLedger(root, [rec({ key: 'a' })]);
    fs.writeFileSync(
      path.join(root, 'cursors.json'),
      JSON.stringify({
        '/x': { offset: 1, size: 1, mtimeMs: 1 },
        '/gone': { offset: 2, size: 2, mtimeMs: 1 },
      }),
    );
    const l = asyncLedger(root);
    l.setCursor('/y', { offset: 7, size: 7, mtimeMs: 1 });
    l.dropCursor('/gone');
    l.flush();
    expect(
      Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'cursors.json'), 'utf8'))),
    ).toEqual(['/x', '/gone']);
    await l.whenReady();
    expect(l.cursorPaths().sort()).toEqual(['/x', '/y']);
    l.flush();
    expect(new UsageLedger({ root }).cursorPaths().sort()).toEqual(['/x', '/y']);
  });
});

describe('UsageLedger：异步压缩与游标写入', () => {
  afterEach(() => jest.restoreAllMocks());

  it('压缩期间的写入 / 同步追加不会随 rename 丢失；并发请求合并成排队的一次', async () => {
    const root = tmp();
    const l = new UsageLedger({ root, flushMs: 60_000 });
    for (let i = 0; i < 9000; i++) l.upsert(rec({ key: `k${i}`, ts: i }));
    for (let i = 0; i < 9000; i++) l.upsert(rec({ key: `k${i}`, ts: i, output: 2 }));
    l.flush();
    const p1 = l.compact();
    // 压缩已开始（快照已取）：期间新增 / 更新并同步追加到旧文件
    l.upsert(rec({ key: 'late', ts: 99_999 }));
    l.upsert(rec({ key: 'k5', ts: 5, output: 50 }));
    l.flush();
    const p2 = l.compact();
    const p3 = l.compact();
    expect(p3).toBe(p2); // 运行中再请求：合并成同一次排队
    await p1;
    // rename 之后同一个 tick 里已补写快照之后的变化
    let disk = new Map(fileLines(root).map((r) => [r.key, r]));
    expect(disk.get('late')).toBeDefined();
    expect(disk.get('k5')!.output).toBe(50);
    await p2;
    const lines = fileLines(root);
    expect(lines).toHaveLength(9001); // 第二次压缩后没有被覆盖的旧行
    disk = new Map(lines.map((r) => [r.key, r]));
    expect(disk.get('k5')!.output).toBe(50);
    const re = new UsageLedger({ root });
    await re.whenReady(); // 超过 1MB：后台载入
    expect(re.size()).toBe(9001);
    expect(re.get('k8999')!.output).toBe(2);
  });

  it('压缩写临时文件期间被清空：放弃这次压缩，旧记录不会复活', async () => {
    const root = tmp();
    const l = new UsageLedger({ root, flushMs: 60_000 });
    for (let i = 0; i < 5000; i++) l.upsert(rec({ key: `k${i}`, ts: i }));
    l.flush();
    const p = l.compact();
    l.clear();
    l.upsert(rec({ key: 'fresh' }));
    l.flush();
    await p;
    expect(fileLines(root).map((r) => r.key)).toEqual(['fresh']);
    expect(fs.readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('close 之后的压缩直接放弃（退出时不会盖掉刚追加的记录）', async () => {
    const root = tmp();
    const l = new UsageLedger({ root, flushMs: 60_000 });
    l.upsert(rec({ key: 'a' }));
    l.upsert(rec({ key: 'a', output: 3 }));
    const p = l.compact();
    l.upsert(rec({ key: 'b' }));
    l.close();
    await p;
    expect(
      new UsageLedger({ root })
        .all()
        .map((r) => r.key)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('定时落盘的游标走异步原子写（不调用 writeFileSync），写完后不再标脏', async () => {
    const root = tmp();
    const l = new UsageLedger({ root, flushMs: 5 });
    const spy = jest.spyOn(fs, 'writeFileSync');
    l.setCursor('/log', { offset: 9, size: 9, mtimeMs: 1 });
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 50 && l.persistState().cursorDirty; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(l.persistState().cursorDirty).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(new UsageLedger({ root }).cursor('/log')?.offset).toBe(9);
  });
});

describe('UsageService：后台载入与查询缓存', () => {
  const mk = (root = tmp(), extra: Record<string, unknown> = {}) =>
    new UsageService({
      events: createRecordingAppEvents(),
      root,
      home: tmp(),
      scanMs: 0,
      logger: { info: jest.fn(), warn: jest.fn() } as never,
      ...extra,
    });

  it('载入完成前的扫描先等账本就绪；查询在就绪后拿到完整数据', async () => {
    const root = tmp();
    const ts = Date.now() - 60_000;
    writeLedger(root, [rec({ key: 'disk', ts, source: 'nomi', via: 'chat', output: 100 })]);
    const svc = mk(root, { ledgerSyncLoadMaxBytes: 0 });
    expect(svc.ledger.isLoaded()).toBe(false);
    await svc.scan();
    expect(svc.ledger.isLoaded()).toBe(true);
    expect(svc.query('today').summary.output).toBe(100);
    svc.stop();
  });

  it('热力图按账本版本缓存：没变化复用，新记录后重算', () => {
    const svc = mk();
    const base = {
      source: 'nomi' as const,
      via: 'chat' as const,
      model: 'gpt-4o',
      promptTokens: 10,
      outputTokens: 5,
    };
    svc.record({ ...base, ts: Date.now() });
    const a = svc.heatmap();
    const b = svc.heatmap();
    expect(b.days).toBe(a.days);
    const today = a.days[a.days.length - 1]!;
    expect(today.calls).toBe(1);
    svc.record({ ...base, ts: Date.now() });
    const c = svc.heatmap();
    expect(c.days).not.toBe(a.days);
    expect(c.days[c.days.length - 1]!.calls).toBe(2);
    svc.stop();
  });

  it('details / csv 改按区间取记录：结果与全量过滤一致', () => {
    const svc = mk();
    const now = Date.now();
    const base = {
      source: 'nomi' as const,
      via: 'chat' as const,
      model: 'gpt-4o',
      promptTokens: 10,
      outputTokens: 5,
    };
    for (let i = 0; i < 5; i++) svc.record({ ...base, ts: now - i * 3_600_000 });
    const q = {
      from: now - 2.5 * 3_600_000,
      to: now + 1,
      sort: 'ts' as const,
      dir: 'desc' as const,
      limit: 100,
      offset: 0,
    };
    const d = svc.details(q);
    expect(d.rows.map((r) => r.ts)).toEqual([now, now - 3_600_000, now - 2 * 3_600_000]);
    expect(svc.csv(q).trim().split('\n')).toHaveLength(4); // 表头 + 3 行
    svc.stop();
  });
});
