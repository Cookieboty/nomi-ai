/**
 * 回归 #46：子进程先退出后再写 stdin 会异步 EPIPE，必须被监听，不能逃逸成主进程异常。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CodeSandbox } from '../../../src/sandbox/CodeSandbox';
import { CliHarnessService } from '../helpers/harness';

const itPosix = process.platform === 'win32' ? it.skip : it;

/** 收集测试期间逃逸到进程级的异常 */
function trapUncaught() {
  const seen: Error[] = [];
  const h = (e: Error) => seen.push(e);
  const listeners = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', h);
  return {
    seen,
    restore() {
      process.removeListener('uncaughtException', h);
      for (const l of listeners) process.on('uncaughtException', l);
    },
  };
}

describe('stdin EPIPE（#46）', () => {
  it('CodeSandbox：程序不读 stdin 就退出，大块 stdin 写入不逃逸', async () => {
    const trap = trapUncaught();
    try {
      const sbx = new CodeSandbox({ runAsNode: false });
      const r = await sbx.run('javascript', 'process.exit(0)', {
        timeoutMs: 10_000,
        stdin: 'x'.repeat(8 * 1024 * 1024),
      });
      await new Promise((r2) => setTimeout(r2, 200));
      expect(r.exitCode).toBe(0);
      expect(trap.seen).toEqual([]);
    } finally {
      trap.restore();
    }
  }, 20_000);

  itPosix(
    'Claude 长驻进程启动即退出，写 NDJSON 不逃逸且本轮失败',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-epipe-'));
      const bin = path.join(dir, 'dead-claude');
      // 关掉 stdin 后再退出：保证父进程的写入撞上已关闭的管道
      fs.writeFileSync(bin, '#!/bin/sh\nexec 0<&-\nsleep 0.2\nexit 3\n', { mode: 0o755 });
      const prev = process.env.NOMI_CLAUDE_BIN;
      process.env.NOMI_CLAUDE_BIN = bin;
      const trap = trapUncaught();
      const h = new CliHarnessService({
        root: path.join(dir, 'root'),
        logger: { info() {}, warn() {} },
        defaultCwd: dir,
      });
      try {
        const tab = h.createTab({ backend: 'claude' });
        await new Promise((r) => setTimeout(r, 50));
        await expect(h.sendTab(tab.id, 'x'.repeat(4 * 1024 * 1024))).rejects.toThrow();
        await new Promise((r) => setTimeout(r, 200));
        expect(trap.seen).toEqual([]);
      } finally {
        h.dispose();
        trap.restore();
        if (prev === undefined) delete process.env.NOMI_CLAUDE_BIN;
        else process.env.NOMI_CLAUDE_BIN = prev;
      }
    },
    20_000,
  );
});
