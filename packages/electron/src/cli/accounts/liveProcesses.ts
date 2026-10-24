/**
 * 账号目录有没有 Nomi 之外的 CLI 进程在用（删除账号前检查，P2.7）。只看进程号与打开的文件，不读任何凭据：
 * - Claude：每个运行中的进程写 `<配置目录>/sessions/<pid>.json`（字段 pid / cwd / kind / startedAt…，
 *   2.1.309 实测；进程退出后可能残留），按 pid 是否还活着判断；
 * - Codex / Grok / Gemini：运行中的进程会一直打开账号目录里的私有文件（Codex 0.163.0 实测：
 *   `state_*.sqlite`、`logs_*.sqlite-shm` 等），用 `lsof +d <目录>`（只看这一层）找；共享条目是软链，
 *   经软链打开的文件解析到用户目录，不会算进来。
 * Windows 没有 lsof：Claude 照常按 sessions 判断，其它 CLI 返回 unknown（由界面上的删除确认兜底）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { AccountKind } from './types';

export type LiveCheck =
  { state: 'busy'; pids: number[] } | { state: 'idle' } | { state: 'unknown' };

export interface LiveDeps {
  platform?: NodeJS.Platform;
  /** pid 是否还活着 */
  alive?: (pid: number) => boolean;
  /** 列出打开了 dir 这一层文件的进程号；工具不可用返回 null */
  openFiles?: (dir: string) => Promise<number[] | null>;
}

const LSOF_TIMEOUT_MS = 5_000;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM：进程在，只是不属于当前用户
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lsofPids(dir: string): Promise<number[] | null> {
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-n', '-P', '-t', '+d', dir],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
      (err, stdout) => {
        const pids = String(stdout ?? '')
          .split(/\s+/)
          .map((x) => Number(x))
          .filter((n) => Number.isInteger(n) && n > 0);
        // 没有任何进程打开时 lsof 以 1 退出、输出为空
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (err && (code === 'ENOENT' || (err as { killed?: boolean }).killed)) resolve(null);
        else resolve(pids);
      },
    );
  });
}

/** Claude：sessions/<pid>.json 里还活着的进程 */
function claudeSessionPids(dir: string, alive: (pid: number) => boolean): number[] | null {
  const sdir = path.join(dir, 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(sdir);
  } catch {
    return null;
  }
  const pids = new Set<number>();
  for (const n of names) {
    // 只看 <pid>.json；同目录的 *.key 不读
    const m = /^(\d+)\.json$/.exec(n);
    if (!m) continue;
    let pid = Number(m[1]);
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(sdir, n), 'utf8')) as { pid?: unknown };
      if (typeof raw.pid === 'number' && Number.isInteger(raw.pid)) pid = raw.pid;
    } catch {
      /* 写到一半 / 不是 JSON：按文件名里的 pid */
    }
    if (pid > 0 && pid !== process.pid && alive(pid)) pids.add(pid);
  }
  return [...pids];
}

/** 私有文件所在的那一层目录 */
function privateDir(kind: AccountKind, dir: string): string {
  return kind === 'gemini' ? path.join(dir, '.gemini') : dir;
}

export async function liveProcesses(
  kind: AccountKind,
  dir: string,
  d: LiveDeps = {},
): Promise<LiveCheck> {
  const alive = d.alive ?? pidAlive;
  if (kind === 'claude') {
    const pids = claudeSessionPids(dir, alive);
    if (pids?.length) return { state: 'busy', pids };
    if (pids) return { state: 'idle' };
  }
  const platform = d.platform ?? process.platform;
  if (!d.openFiles && platform === 'win32') return { state: 'unknown' };
  const target = privateDir(kind, dir);
  if (!fs.existsSync(target)) return { state: 'idle' };
  const open = await (d.openFiles ?? lsofPids)(target).catch(() => null);
  if (!open) return { state: 'unknown' };
  const pids = [...new Set(open)].filter((p) => p !== process.pid);
  return pids.length ? { state: 'busy', pids } : { state: 'idle' };
}
