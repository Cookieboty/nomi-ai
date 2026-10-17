jest.unmock('fs');
jest.unmock('node:fs');

import { spawn } from 'node:child_process';

import { killProcessTree, listDescendants } from '../../../src/cli/processTree';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
};

// pgrep / kill(pid,0) 语义仅 POSIX 适用；Windows 走 taskkill，不在此验证
const d = process.platform === 'win32' ? describe.skip : describe;

d('killProcessTree', () => {
  it('结束子进程及其孙进程，不留孤儿', async () => {
    const script = `
      const { spawn } = require('child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      process.stdout.write(String(g.pid) + '\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    const grandPid = await new Promise<number>((resolve) =>
      child.stdout.once('data', (b: Buffer) => resolve(Number(String(b).trim()))),
    );
    expect(alive(grandPid)).toBe(true);
    expect(listDescendants(child.pid!)).toContain(grandPid);

    killProcessTree(child);
    expect(await until(() => !alive(grandPid))).toBe(true);
    expect(await until(() => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  });

  it('没有 pid / 已退出的进程不抛错', () => {
    expect(() => killProcessTree({ pid: undefined, kill: () => false })).not.toThrow();
    expect(() =>
      killProcessTree({
        pid: 2 ** 22 + 12345,
        kill: () => {
          throw new Error('ESRCH');
        },
      }),
    ).not.toThrow();
  });
});
