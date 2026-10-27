/**
 * ConfigService 写盘：日常 save() 走异步原子写（Windows 上 icacls 也是异步的，不挡主进程），
 * 连续保存按「最后一次写赢」合并；退出路径同步落盘最新配置。
 * 在非 Windows 上通过改写 process.platform + 注入 spawn 断言 icacls 走哪条路。
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

import { app } from 'electron';

import { ConfigService } from '../../../src/services/ConfigService';
import {
  __renameDeps,
  __resetAclCacheForTest,
  __setPrivateRootForTest,
  __setSpawnAsyncForTest,
  __setSpawnSyncForTest,
} from '../../../src/utils/privateFile';

describe('ConfigService 写盘', () => {
  let dir: string;
  const originalPlatform = process.platform;
  const realRenameAsync = __renameDeps.renameAsync;
  const syncCalls: string[][] = [];
  const asyncCalls: string[][] = [];

  const fakeSync = ((_cmd: string, args?: readonly string[]) => {
    syncCalls.push([...(args ?? [])].map(String));
    return { status: 0, signal: null, output: [], pid: 0, stdout: '', stderr: '' };
  }) as unknown as typeof spawnSync;

  const readX = () =>
    (JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as { x?: number }).x;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cfg-save-'));
    (app.getPath as jest.Mock).mockImplementation(() => dir);
    syncCalls.length = 0;
    asyncCalls.length = 0;
    __resetAclCacheForTest();
    // config.json 在 userData 根：根本身不自动收紧，每次原子写都要逐文件收紧
    __setPrivateRootForTest(dir);
    __setSpawnSyncForTest(fakeSync);
    __setSpawnAsyncForTest(async (_cmd, args) => {
      asyncCalls.push(args);
      return { status: 0 };
    });
    process.env.USERNAME = 'alice';
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    __renameDeps.renameAsync = realRenameAsync;
    __setSpawnSyncForTest(null);
    __setSpawnAsyncForTest(null);
    __setPrivateRootForTest(undefined);
    __resetAclCacheForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('save()：Windows 上 icacls 走异步 spawn，不同步阻塞', async () => {
    const c = new ConfigService();
    c.set('x', 1);
    await c.save();
    expect(readX()).toBe(1);
    expect(syncCalls).toHaveLength(0);
    expect(asyncCalls).toHaveLength(1);
    // 兜底路径在 rename 之前收紧临时文件
    expect(asyncCalls[0][0]).toMatch(/config\.json\.\d+\.\d+\.tmp$/);
    expect(asyncCalls[0]).toContain('/inheritance:r');
  });

  it('连续保存：进行中时再保存的合并成一次，最后落盘的是最新配置', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    __renameDeps.renameAsync = async (from, to) => {
      await gate;
      return realRenameAsync(from, to);
    };
    const c = new ConfigService();
    c.set('x', 1);
    const p1 = c.save();
    await new Promise((r) => setTimeout(r, 10)); // 第一次写已经在跑（卡在 rename）
    c.set('x', 2);
    const p2 = c.save();
    c.set('x', 3);
    const p3 = c.save();
    expect(p3).toBe(p2); // 排队的那次合并
    release();
    await Promise.all([p1, p2, p3]);
    expect(readX()).toBe(3);
    expect(asyncCalls).toHaveLength(2); // 两次写盘，而不是三次
    expect(syncCalls).toHaveLength(0);
  });

  it('flushOnQuit：丢掉排队写入、等进行中的写完，再同步写最新配置', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    __renameDeps.renameAsync = async (from, to) => {
      await gate;
      return realRenameAsync(from, to);
    };
    const c = new ConfigService();
    c.set('x', 1);
    const p1 = c.save();
    await new Promise((r) => setTimeout(r, 10));
    c.set('x', 2);
    const queued = c.save();
    const quit = c.flushOnQuit(10_000);
    await new Promise((r) => setTimeout(r, 10));
    expect(syncCalls).toHaveLength(0); // 还在等进行中的那次，不会被它盖回旧内容
    release();
    await quit;
    await Promise.all([p1, queued]);
    expect(readX()).toBe(2);
    expect(syncCalls).toHaveLength(1); // 退出路径同步收紧
    expect(asyncCalls).toHaveLength(1); // 排队的那次没再写
  });

  it('flushOnQuit：进行中的写入超时也照样同步写；它晚到后再补一次同步写', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    __renameDeps.renameAsync = async (from, to) => {
      await gate;
      return realRenameAsync(from, to);
    };
    const c = new ConfigService();
    c.set('x', 1);
    const p1 = c.save();
    await new Promise((r) => setTimeout(r, 10));
    c.set('x', 2);
    await c.flushOnQuit(5);
    expect(readX()).toBe(2);
    expect(syncCalls).toHaveLength(1);
    release();
    await p1; // 旧内容晚到落盘……
    await new Promise((r) => setTimeout(r, 10));
    expect(readX()).toBe(2); // ……随后被补写的最新配置盖回
    expect(syncCalls).toHaveLength(2);
  });

  it('不需要排队时 flushOnQuit 直接同步写', async () => {
    const c = new ConfigService();
    c.set('x', 7);
    await c.flushOnQuit();
    expect(readX()).toBe(7);
    expect(syncCalls).toHaveLength(1);
    expect(asyncCalls).toHaveLength(0);
  });

  it('reload / backup 先等未落盘的保存写完', async () => {
    const c = new ConfigService();
    c.set('modelName', 'm1');
    void c.save();
    const backupPath = await c.backup();
    expect(JSON.parse(fs.readFileSync(backupPath, 'utf8')).modelName).toBe('m1');
    c.set('modelName', 'm2');
    void c.save();
    await c.reload();
    expect(c.get('modelName')).toBe('m2');
  });
});
