#!/usr/bin/env node
/**
 * 在同一工作区并行改动时串行化某个命令：`node scripts/with-lock.mjs <锁名> <命令…>`。
 *
 * 用途：多个代理同时改 `packages/contract` 时，tsup 的 `clean` 会在别人类型检查到一半时清空 dist。
 * 重建契约与依赖它的类型检查都放在同一把锁里跑：
 *
 *   node scripts/with-lock.mjs contract pnpm --filter @nomi-ai/contract build
 *   node scripts/with-lock.mjs contract pnpm --filter @nomi-ai/host-electron typecheck
 *
 * 锁是 `node_modules/.locks/<锁名>` 目录（mkdir 原子创建）；持锁进程退出或超过 10 分钟视为过期。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [name, ...cmd] = process.argv.slice(2);
if (!name || cmd.length === 0 || !/^[a-z0-9-]+$/.test(name)) {
  process.stderr.write('usage: node scripts/with-lock.mjs <lock-name> <command...>\n');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'node_modules', '.locks', name);
const owner = path.join(dir, 'owner');
const STALE_MS = 10 * 60_000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stale() {
  try {
    const st = fs.statSync(dir);
    const pid = Number(fs.readFileSync(owner, 'utf8'));
    return Date.now() - st.mtimeMs > STALE_MS || (Number.isInteger(pid) && !alive(pid));
  } catch {
    return false;
  }
}

fs.mkdirSync(path.dirname(dir), { recursive: true });
for (let waited = 0; ; waited += 500) {
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(owner, String(process.pid));
    break;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (stale()) {
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (waited % 30_000 === 0) process.stderr.write(`[with-lock] waiting for '${name}'…\n`);
    sleep(500);
  }
}

let r;
try {
  r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', cwd: process.cwd() });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(r?.status ?? 1);
