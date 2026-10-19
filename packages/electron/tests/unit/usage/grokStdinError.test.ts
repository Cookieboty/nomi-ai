jest.unmock('fs');
jest.unmock('path');

import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { readGrokAuthStatus } from '../../../src/usage/grokAuth';
import { GrokBillingFetcher } from '../../../src/usage/grokSubscription';

/**
 * 真正的 Writable：写入回调里异步报 EPIPE（child 的 error 事件和 write 外的同步 try/catch 接不到）。
 * failOnWrite = 第几次写入失败（1 = 第一次 initialize 就失败）。
 */
function epipeChild(failOnWrite: number, reply?: (msg: Record<string, unknown>) => unknown) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    kill: jest.Mock;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.stdout = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = jest.fn(() => {
    child.exitCode = 0;
    child.emit('close', 0);
    return true;
  });
  let writes = 0;
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      writes++;
      if (writes >= failOnWrite) {
        setImmediate(() => cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
        return;
      }
      cb();
      const out = reply?.(JSON.parse(String(chunk)) as Record<string, unknown>);
      if (out) setImmediate(() => child.stdout.write(`${JSON.stringify(out)}\n`));
    },
  });
  return child;
}

const asSpawn = (child: unknown) => (() => child) as unknown as typeof spawn;

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-grok-epipe-'));

describe('Grok ACP 子进程 stdin 异步 EPIPE：降级为不可用，不触发全局异常', () => {
  let uncaught: unknown[];
  const onUncaught = (e: unknown) => uncaught.push(e);
  beforeEach(() => {
    uncaught = [];
    process.on('uncaughtException', onUncaught);
  });
  afterEach(() => process.off('uncaughtException', onUncaught));

  it('登录探测：initialize 写入即 EPIPE → 返回 null，临时目录回收', async () => {
    const root = tmpRoot();
    const child = epipeChild(1);
    const out = await readGrokAuthStatus({
      resolveBin: async () => process.execPath,
      spawnFn: asSpawn(child),
      tmpRoot: root,
      timeoutMs: 3000,
      env: () => ({ ...process.env }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(out).toBeNull();
    expect(uncaught).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(child.kill).toHaveBeenCalled();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('额度读取：initialize 成功、initialized→billing 之间 EPIPE → transient，只结算一次', async () => {
    const root = tmpRoot();
    const child = epipeChild(2, (msg) => (msg.id === 1 ? { id: 1, result: { ok: true } } : null));
    const outcome = await new GrokBillingFetcher({
      resolveBin: async () => process.execPath,
      spawnFn: asSpawn(child),
      tmpRoot: root,
      timeoutMs: 3000,
      env: () => ({ ...process.env }),
    }).fetch();
    await new Promise((r) => setTimeout(r, 20));
    expect(outcome.kind).toBe('transient');
    expect(uncaught).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('额度读取：第一次写入就 EPIPE（进程刚创建就退出）→ transient，不等超时', async () => {
    const root = tmpRoot();
    const child = epipeChild(1);
    const t0 = Date.now();
    const outcome = await new GrokBillingFetcher({
      resolveBin: async () => process.execPath,
      spawnFn: asSpawn(child),
      tmpRoot: root,
      timeoutMs: 5000,
      env: () => ({ ...process.env }),
    }).fetch();
    expect(outcome.kind).toBe('transient');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(uncaught).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
