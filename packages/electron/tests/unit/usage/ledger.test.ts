jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { UsageRecord } from '../../../src/usage/types';
import { UsageLedger } from '../../../src/usage/UsageLedger';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-'));
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

describe('UsageLedger', () => {
  it('同键后写覆盖：token 只增不减；无变化返回 false', () => {
    const root = tmp();
    const l = new UsageLedger({ root });
    expect(l.upsert(rec({ output: 5 }))).toBe(true);
    expect(l.upsert(rec({ output: 3 }))).toBe(false);
    expect(l.upsert(rec({ output: 9 }))).toBe(true);
    expect(l.size()).toBe(1);
    expect(l.all()[0]!.output).toBe(9);
  });

  it('新字段兼容：cacheWrite1h / fast 只增不减；旧记录（无字段）读出来仍是旧口径，落盘后保持', () => {
    const root = tmp();
    const l = new UsageLedger({ root });
    l.upsert(rec({ cacheWrite: 10 }));
    expect('cacheWrite1h' in l.all()[0]!).toBe(false);
    expect(l.upsert(rec({ cacheWrite: 10, cacheWrite1h: 4, fast: true }))).toBe(true);
    expect(l.upsert(rec({ cacheWrite: 10 }))).toBe(false); // 后到的旧口径行不会清掉新字段
    expect(l.all()[0]).toMatchObject({ cacheWrite1h: 4, fast: true });
    l.flush();
    const l2 = new UsageLedger({ root });
    expect(l2.all()[0]).toMatchObject({ cacheWrite: 10, cacheWrite1h: 4, fast: true });
  });

  it('落盘后重新载入：覆盖行只保留最新，损坏行忽略，游标保留', () => {
    const root = tmp();
    const a = new UsageLedger({ root });
    a.upsert(rec({ key: 'a', output: 1 }));
    a.upsert(rec({ key: 'a', output: 7 }));
    a.upsert(rec({ key: 'b', ts: 2_000_000 }));
    a.setCursor('/x/y.jsonl', { offset: 10, size: 10, mtimeMs: 1 });
    a.flush();
    fs.appendFileSync(path.join(root, 'ledger.jsonl'), '{half-written');
    const b = new UsageLedger({ root });
    expect(b.size()).toBe(2);
    expect(b.all().find((r) => r.key === 'a')!.output).toBe(7);
    expect(b.cursor('/x/y.jsonl')?.offset).toBe(10);
    // 文件权限仅当前用户（POSIX）
    if (process.platform !== 'win32')
      expect(fs.statSync(path.join(root, 'ledger.jsonl')).mode & 0o077).toBe(0);
  });

  it('range 二分取区间（左闭右开）', () => {
    const l = new UsageLedger({ root: tmp() });
    for (let i = 0; i < 10; i++) l.upsert(rec({ key: `k${i}`, ts: i * 100 }));
    expect(l.range(200, 500).map((r) => r.key)).toEqual(['k2', 'k3', 'k4']);
    expect(l.range(5000, 6000)).toEqual([]);
  });

  it('保留期：prune 删除过期记录', () => {
    const now = 400 * 86_400_000;
    const l = new UsageLedger({ root: tmp(), now: () => now });
    l.upsert(rec({ key: 'old', ts: now - 100 * 86_400_000 }));
    l.upsert(rec({ key: 'new', ts: now - 10 * 86_400_000 }));
    expect(l.prune('forever')).toBe(0);
    expect(l.prune('1y')).toBe(0);
    expect(l.prune('90d')).toBe(1);
    expect(l.all().map((r) => r.key)).toEqual(['new']);
  });

  it('一键清空：记录清零（磁盘也清），游标保留避免重复导入', () => {
    const root = tmp();
    const l = new UsageLedger({ root });
    l.upsert(rec());
    l.setCursor('/f', { offset: 1, size: 1, mtimeMs: 1 });
    l.flush();
    l.clear();
    expect(l.size()).toBe(0);
    expect(fs.readFileSync(path.join(root, 'ledger.jsonl'), 'utf8')).toBe('');
    expect(l.cursor('/f')).toBeDefined();
    expect(new UsageLedger({ root }).size()).toBe(0);
  });

  it('路由去重窗口：日志时间落在路由请求 [开始-15s, 结束+15s] 内才算已覆盖，且只认同来源', () => {
    const l = new UsageLedger({ root: tmp() });
    l.upsert(rec({ key: 'r1', via: 'route', source: 'claude', ts: 1_000_000, dur: 60_000 }));
    expect(l.coveredByRoute('claude', 1_000_000 + 30_000)).toBe(true);
    expect(l.coveredByRoute('claude', 1_000_000 - 10_000)).toBe(true);
    expect(l.coveredByRoute('claude', 1_000_000 + 60_000 + 14_000)).toBe(true);
    expect(l.coveredByRoute('claude', 1_000_000 + 60_000 + 20_000)).toBe(false);
    expect(l.coveredByRoute('claude', 1_000_000 - 20_000)).toBe(false);
    expect(l.coveredByRoute('codex', 1_000_000)).toBe(false);
  });

  it('attribute 只补缺的会话 / 项目、不改 token；version 随写入变化；重开后保留', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-ledger-attr-'));
    const a = new UsageLedger({ root });
    const v0 = a.version();
    a.upsert(rec({ key: 'r', via: 'route' }));
    expect(a.version()).toBeGreaterThan(v0);
    const v1 = a.version();
    expect(a.attribute('r', { session: 's9', project: 'p' })).toBe(true);
    expect(a.version()).toBeGreaterThan(v1);
    // 已有的不覆盖；没变化返回 false
    expect(a.attribute('r', { session: 'other', project: 'x' })).toBe(false);
    expect(a.attribute('nope', { session: 's' })).toBe(false);
    expect(a.all()[0]).toMatchObject({ session: 's9', project: 'p' });
    a.flush();
    const b = new UsageLedger({ root });
    expect(b.all()[0]).toMatchObject({ key: 'r', session: 's9', project: 'p' });
  });
});
