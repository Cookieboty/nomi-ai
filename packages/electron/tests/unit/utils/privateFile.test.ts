/**
 * privateFile：POSIX chmod 与 Windows icacls 收紧 ACL。
 * 不依赖真实 Windows——在 Linux CI 上通过改写 process.platform + 注入 spawnSync 断言 argv。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.unmock('node:child_process');
jest.unmock('node:os');

import type { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  __renameDeps,
  __resetAclCacheForTest,
  __setPrivateRootForTest,
  __setSpawnAsyncForTest,
  writePrivateFileAtomicAsync,
  __setSpawnSyncForTest,
  ensurePrivateDir,
  tightenWindowsAcl,
  windowsAclUser,
  writePrivateFile,
  writePrivateFileAtomic,
} from '../../../src/utils/privateFile';

describe('privateFile Windows ACL', () => {
  let dir: string;
  const originalPlatform = process.platform;
  const envSnap = {
    USERNAME: process.env.USERNAME,
    USERDOMAIN: process.env.USERDOMAIN,
  };
  const calls: Array<{ cmd: string; args: string[] }> = [];

  const fakeSpawn = ((cmd: string, args?: readonly string[]) => {
    calls.push({ cmd: String(cmd), args: [...(args ?? [])].map(String) });
    return {
      status: 0,
      signal: null,
      output: [],
      pid: 0,
      stdout: '',
      stderr: '',
      error: undefined,
    };
  }) as unknown as typeof spawnSync;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
    calls.length = 0;
    __resetAclCacheForTest();
    __setPrivateRootForTest(null);
    __setSpawnSyncForTest(fakeSpawn);
    process.env.USERNAME = 'alice';
    process.env.USERDOMAIN = 'CORP';
  });

  afterEach(() => {
    __setSpawnSyncForTest(null);
    __setSpawnAsyncForTest(null);
    __setPrivateRootForTest(undefined);
    __resetAclCacheForTest();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (envSnap.USERNAME === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = envSnap.USERNAME;
    if (envSnap.USERDOMAIN === undefined) delete process.env.USERDOMAIN;
    else process.env.USERDOMAIN = envSnap.USERDOMAIN;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('windowsAclUser：DOMAIN\\user；已有反斜杠不再叠域名', () => {
    expect(windowsAclUser()).toBe('CORP\\alice');
    process.env.USERNAME = 'CORP\\bob';
    expect(windowsAclUser()).toBe('CORP\\bob');
    process.env.USERDOMAIN = 'WORKGROUP';
    process.env.USERNAME = 'carol';
    expect(windowsAclUser()).toBe('carol');
  });

  it('win32：writePrivateFile / Atomic / ensurePrivateDir 调用 icacls 且 argv 形状正确', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const file = path.join(dir, 'token');
    writePrivateFile(file, 'secret');
    expect(fs.readFileSync(file, 'utf8')).toBe('secret');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cmd: 'icacls',
      args: [file, '/inheritance:r', '/grant:r', 'CORP\\alice:(F)'],
    });

    calls.length = 0;
    writePrivateFileAtomic(file, 'secret2');
    expect(fs.readFileSync(file, 'utf8')).toBe('secret2');
    // 原子写在 rename 之前收紧临时文件（ACE 随文件一起 rename）
    expect(calls).toEqual([
      { cmd: 'icacls', args: [`${file}.tmp`, '/inheritance:r', '/grant:r', 'CORP\\alice:(F)'] },
    ]);

    calls.length = 0;
    const tokDir = path.join(dir, 'tokens');
    ensurePrivateDir(tokDir);
    expect(fs.statSync(tokDir).isDirectory()).toBe(true);
    expect(calls).toEqual([
      {
        cmd: 'icacls',
        args: [tokDir, '/inheritance:r', '/grant:r', 'CORP\\alice:(OI)(CI)F'],
      },
    ]);
  });

  it('非 win32：不调用 icacls', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const file = path.join(dir, 'a');
    writePrivateFile(file, 'x');
    writePrivateFileAtomic(file, 'y');
    ensurePrivateDir(path.join(dir, 'd'));
    tightenWindowsAcl(file, 'file');
    expect(calls).toEqual([]);
  });

  it('icacls 失败只 warn，不抛、文件仍在', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    __setSpawnSyncForTest((() => ({
      status: 5,
      signal: null,
      output: [],
      pid: 0,
      stdout: '',
      stderr: 'Access is denied.',
      error: undefined,
    })) as unknown as typeof spawnSync);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const file = path.join(dir, 't');
    expect(() => writePrivateFile(file, 'keep')).not.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('keep');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('privateFile Windows ACL 缓存', () => {
  let root: string;
  const originalPlatform = process.platform;
  const envSnap = { USERNAME: process.env.USERNAME, USERDOMAIN: process.env.USERDOMAIN };
  const calls: string[][] = [];
  let status = 0;
  const fakeSpawn = ((_cmd: string, args?: readonly string[]) => {
    calls.push([...(args ?? [])].map(String));
    return { status, signal: null, output: [], pid: 0, stdout: '', stderr: '', error: undefined };
  }) as unknown as typeof spawnSync;
  const asyncCalls: string[][] = [];
  const dirGrant = ['/inheritance:r', '/grant:r', 'CORP\\alice:(OI)(CI)F'];
  const fileGrant = ['/inheritance:r', '/grant:r', 'CORP\\alice:(F)'];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cache-'));
    calls.length = 0;
    asyncCalls.length = 0;
    status = 0;
    __resetAclCacheForTest();
    __setPrivateRootForTest(root);
    __setSpawnSyncForTest(fakeSpawn);
    __setSpawnAsyncForTest(async (_cmd, args) => {
      asyncCalls.push(args);
      return { status };
    });
    process.env.USERNAME = 'alice';
    process.env.USERDOMAIN = 'CORP';
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    __setSpawnSyncForTest(null);
    __setSpawnAsyncForTest(null);
    __setPrivateRootForTest(undefined);
    __resetAclCacheForTest();
    if (envSnap.USERNAME === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = envSnap.USERNAME;
    if (envSnap.USERDOMAIN === undefined) delete process.env.USERDOMAIN;
    else process.env.USERDOMAIN = envSnap.USERDOMAIN;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('userData 子目录：首次写只收紧目录一次，之后同目录的写入（普通 / 原子 / 新文件）都不再 icacls', () => {
    const sub = path.join(root, 'usage');
    fs.mkdirSync(sub);
    const a = path.join(sub, 'cursors.json');
    writePrivateFile(a, '1');
    expect(calls).toEqual([[sub, ...dirGrant]]);
    calls.length = 0;
    writePrivateFile(a, '2');
    writePrivateFileAtomic(a, '3');
    writePrivateFileAtomic(path.join(sub, 'b.json'), 'b');
    writePrivateFile(path.join(sub, 'c.json'), 'c');
    expect(calls).toEqual([]);
    expect(fs.readFileSync(a, 'utf8')).toBe('3');
    expect(fs.readdirSync(sub).sort()).toEqual(['b.json', 'c.json', 'cursors.json']);
  });

  it('私有目录里的历史遗留文件：首次覆盖写逐文件修正一次，之后跳过', () => {
    const sub = path.join(root, 'gateway');
    fs.mkdirSync(sub);
    const legacy = path.join(sub, 'store.json');
    fs.writeFileSync(legacy, 'old');
    writePrivateFile(legacy, 'new');
    expect(calls).toEqual([
      [sub, ...dirGrant],
      [legacy, ...fileGrant],
    ]);
    calls.length = 0;
    writePrivateFile(legacy, 'newer');
    expect(calls).toEqual([]);
  });

  it('目录被删后重建：缓存失效，重新收紧', () => {
    const sub = path.join(root, 'accounts');
    fs.mkdirSync(sub);
    writePrivateFileAtomic(path.join(sub, 'a.json'), '1');
    // 旧目录先挪走、新目录建好后再删：Linux 上删掉立刻重建可能复用同一个 inode + birthtime，
    // 身份撞上就测不出「重建」（真实场景里间隔很长，这里只为让测试稳定）
    const old = `${sub}.old`;
    fs.renameSync(sub, old);
    fs.mkdirSync(sub);
    fs.rmSync(old, { recursive: true });
    calls.length = 0;
    writePrivateFileAtomic(path.join(sub, 'a.json'), '2');
    expect(calls).toEqual([[sub, ...dirGrant]]);
  });

  it('兜底：userData 根 / 外部目录不自动收紧；普通写同一文件只收紧一次，原子写每次收紧', () => {
    const cfg = path.join(root, 'config.json');
    writePrivateFileAtomic(cfg, '1');
    writePrivateFileAtomic(cfg, '2');
    expect(calls).toEqual([
      [`${cfg}.tmp`, ...fileGrant],
      [`${cfg}.tmp`, ...fileGrant],
    ]);
    calls.length = 0;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-outside-'));
    try {
      const f = path.join(outside, 'settings.json');
      writePrivateFile(f, 'x');
      writePrivateFile(f, 'y');
      expect(calls).toEqual([[f, ...fileGrant]]);
      // 文件被删除后重建：身份变了，重新收紧
      // 同上：旧文件挪走后再建新文件，保证 inode 不被复用
      fs.renameSync(f, `${f}.old`);
      writePrivateFile(f, 'z');
      fs.rmSync(`${f}.old`);
      expect(calls).toEqual([
        [f, ...fileGrant],
        [f, ...fileGrant],
      ]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('兜底：目录收紧失败后不再重试目录，改为逐文件收紧', () => {
    const sub = path.join(root, 'shared');
    fs.mkdirSync(sub);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    status = 5;
    const f = path.join(sub, 'a.json');
    writePrivateFileAtomic(f, '1');
    // icacls 全部失败：临时文件收紧失败后 rename 完再对目标补一次
    expect(calls).toEqual([
      [sub, ...dirGrant],
      [`${f}.tmp`, ...fileGrant],
      [f, ...fileGrant],
    ]);
    status = 0;
    calls.length = 0;
    writePrivateFileAtomic(f, '2');
    expect(calls).toEqual([[`${f}.tmp`, ...fileGrant]]);
    warn.mockRestore();
  });

  it('ensurePrivateDir 显式收紧的目录（即使在 userData 之外）也算私有，且只收紧一次', () => {
    __setPrivateRootForTest(null);
    const tokens = path.join(root, 'tokens');
    ensurePrivateDir(tokens);
    ensurePrivateDir(tokens);
    expect(calls).toEqual([[tokens, ...dirGrant]]);
    calls.length = 0;
    writePrivateFile(path.join(tokens, 't1'), 'x');
    writePrivateFileAtomic(path.join(tokens, 't2'), 'y');
    expect(calls).toEqual([]);
  });

  it('异步原子写：icacls 走异步 spawn，并发写同一目录只收紧一次目录', async () => {
    const sub = path.join(root, 'chat');
    fs.mkdirSync(sub);
    await Promise.all([
      writePrivateFileAtomicAsync(path.join(sub, 'a.json'), 'a'),
      writePrivateFileAtomicAsync(path.join(sub, 'b.json'), 'b'),
    ]);
    expect(asyncCalls).toEqual([[sub, ...dirGrant]]);
    await writePrivateFileAtomicAsync(path.join(sub, 'a.json'), 'a2');
    expect(asyncCalls).toHaveLength(1);
    expect(calls).toEqual([]);

    // 兜底目录：每次异步逐文件收紧，不走同步 spawn
    const cfg = path.join(root, 'config.json');
    await writePrivateFileAtomicAsync(cfg, '1');
    expect(asyncCalls.slice(1)).toEqual([
      [expect.stringMatching(/config\.json\.\d+\.\d+\.tmp$/), ...fileGrant],
    ]);
    expect(calls).toEqual([]);
  });

  it('非 win32：缓存逻辑完全不介入，不调用 icacls', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const sub = path.join(root, 'usage');
    fs.mkdirSync(sub);
    writePrivateFile(path.join(sub, 'a'), '1');
    writePrivateFileAtomic(path.join(sub, 'b'), '2');
    await writePrivateFileAtomicAsync(path.join(sub, 'c'), '3');
    expect(calls).toEqual([]);
    expect(asyncCalls).toEqual([]);
    expect((fs.statSync(path.join(sub, 'a')).mode & 0o777).toString(8)).toBe('600');
  });
});

describe('writePrivateFileAtomic rename 重试', () => {
  const original = { ...__renameDeps };
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-rename-'));
  });
  afterEach(() => {
    Object.assign(__renameDeps, original);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const busy = (code: string) => Object.assign(new Error(code), { code });

  it('Windows 上目标被短暂占用（EPERM）时退避重试直到成功', () => {
    const file = path.join(dir, 'a.json');
    let failures = 2;
    const sleeps: number[] = [];
    __renameDeps.platform = () => 'darwin';
    __renameDeps.rename = (from, to) => {
      if (failures-- > 0) throw busy('EPERM');
      fs.renameSync(from, to);
    };
    __renameDeps.sleep = (ms) => {
      sleeps.push(ms);
      return 'ok';
    };
    expect(() => writePrivateFileAtomic(file, '{}')).toThrow('EPERM');

    failures = 2;
    __renameDeps.platform = () => 'win32';
    writePrivateFileAtomic(file, '{"x":1}');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"x":1}');
    expect(sleeps).toEqual([10, 20]);
  });

  it('非瞬时错误不重试', () => {
    __renameDeps.platform = () => 'win32';
    const rename = jest.fn(() => {
      throw busy('ENOENT');
    });
    __renameDeps.rename = rename;
    expect(() => writePrivateFileAtomic(path.join(dir, 'b.json'), '{}')).toThrow('ENOENT');
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('异步版本：占用时用定时器退避，等待期间事件循环照常（#154）', async () => {
    const file = path.join(dir, 'c.json');
    let failures = 3;
    const sleeps: number[] = [];
    __renameDeps.platform = () => 'win32';
    __renameDeps.renameAsync = async (from, to) => {
      if (failures-- > 0) throw busy('EBUSY');
      fs.renameSync(from, to);
    };
    __renameDeps.sleepAsync = (ms) => {
      sleeps.push(ms);
      return new Promise((r) => setTimeout(r, 1));
    };
    const sync = jest.fn();
    __renameDeps.sleep = sync;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    try {
      await writePrivateFileAtomicAsync(file, '{"y":2}');
    } finally {
      clearInterval(timer);
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('{"y":2}');
    expect(sleeps).toEqual([10, 20, 40]);
    expect(sync).not.toHaveBeenCalled();
    expect(ticks).toBeGreaterThan(0);
    expect(fs.readdirSync(dir)).toEqual(['c.json']);
  });

  it('异步版本：同一路径按调用顺序串行，失败清掉临时文件并抛出', async () => {
    const file = path.join(dir, 'd.json');
    __renameDeps.platform = () => 'win32';
    let first = true;
    __renameDeps.renameAsync = async (from, to) => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 20));
      }
      fs.renameSync(from, to);
    };
    await Promise.all([
      writePrivateFileAtomicAsync(file, '1'),
      writePrivateFileAtomicAsync(file, '2'),
      writePrivateFileAtomicAsync(file, '3'),
    ]);
    expect(fs.readFileSync(file, 'utf8')).toBe('3');

    __renameDeps.renameAsync = async () => {
      throw busy('ENOENT');
    };
    await expect(writePrivateFileAtomicAsync(file, '4')).rejects.toThrow('ENOENT');
    expect(fs.readFileSync(file, 'utf8')).toBe('3');
    expect(fs.readdirSync(dir)).toEqual(['d.json']);
  });
});
