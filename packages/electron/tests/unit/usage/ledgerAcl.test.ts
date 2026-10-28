/**
 * 账本压缩在 Windows 上不同步跑 icacls：账本目录是自动收紧的 userData 子目录时临时文件靠继承就是私有的，
 * 只异步收紧目录一次；目录收紧不了时对临时文件异步收紧。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.unmock('node:child_process');
jest.unmock('node:os');
jest.mock('electron', () => ({
  app: { getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { UsageRecord } from '../../../src/usage/types';
import { UsageLedger } from '../../../src/usage/UsageLedger';
import {
  __resetAclCacheForTest,
  __setPrivateRootForTest,
  __setSpawnAsyncForTest,
  __setSpawnSyncForTest,
} from '../../../src/utils/privateFile';

const rec = (key: string): UsageRecord => ({
  key,
  ts: Date.now(),
  source: 'claude',
  via: 'log',
  model: 'm',
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
});

describe('UsageLedger 压缩的 Windows ACL', () => {
  let userData: string;
  let root: string;
  const originalPlatform = process.platform;
  const asyncCalls: string[][] = [];
  let syncCalls = 0;

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-ledger-acl-'));
    root = path.join(userData, 'usage');
    asyncCalls.length = 0;
    syncCalls = 0;
    __resetAclCacheForTest();
    // 压缩路径不应同步 spawn icacls（tightenWindowsAcl 会吞掉异常，所以只计数、最后断言为 0）
    __setSpawnSyncForTest((() => {
      syncCalls++;
      return { status: 0, stderr: '' };
    }) as never);
    __setSpawnAsyncForTest(async (_cmd, args) => {
      asyncCalls.push(args);
      return { status: 0 };
    });
    process.env.USERNAME = 'alice';
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    __setSpawnSyncForTest(null);
    __setSpawnAsyncForTest(null);
    __setPrivateRootForTest(undefined);
    __resetAclCacheForTest();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  const compactTwice = async () => {
    const l = new UsageLedger({ root, flushMs: 60_000 });
    Object.defineProperty(process, 'platform', { value: 'win32' });
    l.upsert(rec('a'));
    await l.compact();
    l.upsert(rec('b'));
    await l.compact();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    const keys = fs
      .readFileSync(path.join(root, 'ledger.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((s) => (JSON.parse(s) as UsageRecord).key);
    expect(new Set(keys)).toEqual(new Set(['a', 'b']));
    expect(syncCalls).toBe(0);
  };

  it('userData 子目录：只异步收紧目录一次，临时文件继承私有 ACL、不逐个收紧', async () => {
    __setPrivateRootForTest(userData);
    await compactTwice();
    expect(asyncCalls).toHaveLength(1);
    expect(asyncCalls[0][0]).toBe(root);
    expect(asyncCalls[0]).toContain('alice:(OI)(CI)F');
  });

  it('目录不能自动收紧：每次压缩对临时文件异步收紧（仍然没有同步 spawn）', async () => {
    __setPrivateRootForTest(null);
    await compactTwice();
    expect(asyncCalls).toHaveLength(2);
    for (const a of asyncCalls) {
      expect(a[0]).toMatch(/ledger\.jsonl\..+\.tmp$/);
      expect(a).toContain('alice:(F)');
    }
  });
});
