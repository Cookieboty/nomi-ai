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
    __setSpawnSyncForTest(fakeSpawn);
    process.env.USERNAME = 'alice';
    process.env.USERDOMAIN = 'CORP';
  });

  afterEach(() => {
    __setSpawnSyncForTest(null);
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
    expect(calls).toEqual([
      { cmd: 'icacls', args: [file, '/inheritance:r', '/grant:r', 'CORP\\alice:(F)'] },
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
