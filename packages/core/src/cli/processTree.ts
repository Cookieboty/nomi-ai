/**
 * 结束一个子进程及其整棵子孙进程树。
 *
 * CLI（claude / codex / dsh）会再拉起自己的工具进程、MCP server 等；
 * 只对直接子进程 `child.kill()` 会留下孤儿进程。
 * - Windows：`taskkill /T /F`；
 * - POSIX：用 `pgrep -P` 递归收集子孙，自底向上 SIGKILL，最后杀本体。
 * 全部同步、尽力而为（进程可能已退出），用于应用退出路径。
 */
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process';

function childrenOf(pid: number): number[] {
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return out
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return []; // 没有子进程时 pgrep 退出码为 1
  }
}

export function listDescendants(pid: number, depthLimit = 8): number[] {
  const all: number[] = [];
  const walk = (p: number, depth: number) => {
    if (depth > depthLimit) return;
    for (const c of childrenOf(p)) {
      walk(c, depth + 1);
      all.push(c); // 后序：子孙在前
    }
  };
  walk(pid, 0);
  return all;
}

export function killProcessTree(child: Pick<ChildProcess, 'pid' | 'kill'>): void {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 });
    } catch {
      /* */
    }
    return;
  }
  // 先收集再杀：杀掉父进程后子孙会被 init 收养，就找不到了
  for (const p of listDescendants(pid)) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
}
