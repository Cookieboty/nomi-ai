jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  peekCliBin,
  refreshCliBin,
  resetCliBinCache,
  resolveCliBinAsync,
  resolveCliBinCached,
} from '../../../src/cli/detect';

/** 用一个假的 PATH 目录里的可执行文件做探测，避免依赖本机真实安装的 CLI */
describe('CLI 可执行文件探测缓存', () => {
  let dir = '';
  let bin = '';
  const saved = { path: process.env.PATH, bin: process.env.NOMI_DSH_BIN };

  beforeEach(() => {
    resetCliBinCache();
    delete process.env.NOMI_DSH_BIN;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-cache-'));
    bin = path.join(dir, 'dsh');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${saved.path ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = saved.path;
    if (saved.bin === undefined) delete process.env.NOMI_DSH_BIN;
    else process.env.NOMI_DSH_BIN = saved.bin;
    fs.rmSync(dir, { recursive: true, force: true });
    resetCliBinCache();
  });

  it('未探测过时 peek 返回 undefined（读状态时不会被迫 spawn）', () => {
    expect(peekCliBin('dsh')).toBeUndefined();
  });

  it('同步探测一次后写入缓存，之后直接命中（PATH 变了也不再 spawn）', () => {
    const first = resolveCliBinCached('dsh');
    expect(first && fs.realpathSync.native(first)).toBe(fs.realpathSync.native(bin));
    process.env.PATH = '/nonexistent';
    expect(peekCliBin('dsh')).toBe(first);
    expect(resolveCliBinCached('dsh')).toBe(first);
  });

  it('缓存的可执行文件被删除后失效', () => {
    expect(resolveCliBinCached('dsh')).toBeTruthy();
    fs.rmSync(bin);
    expect(peekCliBin('dsh')).toBeUndefined();
  });

  it('异步探测写入缓存，并发请求合并', async () => {
    const a = refreshCliBin('dsh');
    const b = refreshCliBin('dsh');
    expect(a).toBe(b);
    const found = await a;
    expect(found && fs.realpathSync.native(found)).toBe(fs.realpathSync.native(bin));
    expect(peekCliBin('dsh')).toBe(found);
  });

  it('resolveCliBinAsync（更新服务用）也会刷新缓存', async () => {
    const found = await resolveCliBinAsync('dsh');
    expect(found).toBeTruthy();
    expect(peekCliBin('dsh')).toBe(found);
  });

  it('Windows 上优先 .cmd 垫片，而不是 npm 的无扩展名脚本', () => {
    if (process.platform !== 'win32') return;
    fs.writeFileSync(path.join(dir, 'dsh.cmd'), '@echo off\r\n');
    resetCliBinCache();
    const found = resolveCliBinCached('dsh');
    expect(found && path.basename(found).toLowerCase()).toBe('dsh.cmd');
  });

  it('环境变量覆盖始终优先、立即生效，不受缓存影响', () => {
    expect(resolveCliBinCached('dsh')).toBeTruthy();
    const other = path.join(dir, 'other-dsh');
    fs.writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 });
    process.env.NOMI_DSH_BIN = other;
    expect(peekCliBin('dsh')).toBe(other);
    expect(resolveCliBinCached('dsh')).toBe(other);
  });

  it('「未找到」只缓存很短时间，之后会重新探测', async () => {
    fs.rmSync(bin);
    process.env.PATH = '/nonexistent';
    // withCliPath 会补上 %APPDATA%\npm。Windows 上只改 HOME 仍会命中真实安装的 dsh。
    const savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
    };
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.APPDATA = dir;
    // 兜底目录还会查 nvm / volta / pnpm 等（#76）：别命中开发机上真实安装的 dsh
    const homeSpy = jest.spyOn(os, 'homedir').mockReturnValue(dir);
    const vm = Object.fromEntries(
      ['NVM_BIN', 'NVM_DIR', 'VOLTA_HOME', 'PNPM_HOME', 'NPM_CONFIG_PREFIX'].map((k) => [
        k,
        process.env[k],
      ]),
    );
    for (const k of Object.keys(vm)) delete process.env[k];
    const spy = jest.spyOn(Date, 'now');
    try {
      const now = 1_000_000;
      spy.mockReturnValue(now);
      expect(await refreshCliBin('dsh')).toBeNull();
      expect(peekCliBin('dsh')).toBeNull();
      spy.mockReturnValue(now + 11_000);
      expect(peekCliBin('dsh')).toBeUndefined();
    } finally {
      homeSpy.mockRestore();
      for (const [k, v] of Object.entries(vm)) if (v !== undefined) process.env[k] = v;
      spy.mockRestore();
      process.env.HOME = savedEnv.HOME;
      process.env.USERPROFILE = savedEnv.USERPROFILE;
      process.env.APPDATA = savedEnv.APPDATA;
    }
  });
});
