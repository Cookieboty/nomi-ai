import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoPath } from '@nomi-ai/repo-paths';

import { copyCss } from './copy-css.mjs';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRunBin = repoPath('scripts/run-bin.mjs');

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function renameWithRetry(from, to, renameFn, retries = 5) {
  let attempt = 0;
  while (true) {
    try {
      renameFn(from, to);
      return;
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : undefined;
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= retries) {
        throw err;
      }
      attempt += 1;
      await sleep(50 * attempt);
    }
  }
}

/**
 * 将同文件系统下的 stagingDir 原子替换为 distDir。
 * 若 distDir 已存在，先移至 backupDir，再将 stagingDir 移入 distDir；若第二步失败则立即回滚。
 */
export async function replaceDirAtomically({
  stagingDir,
  distDir,
  backupDir,
  renameFn = renameSync,
  rmFn = rmSync,
  existsFn = existsSync,
}) {
  const hasExisting = existsFn(distDir);
  if (!hasExisting) {
    await renameWithRetry(stagingDir, distDir, renameFn);
    return;
  }

  if (existsFn(backupDir)) {
    rmFn(backupDir, { recursive: true, force: true });
  }
  await renameWithRetry(distDir, backupDir, renameFn);
  try {
    await renameWithRetry(stagingDir, distDir, renameFn);
  } catch (err) {
    // 替换失败时立即恢复旧产物，避免 dist 消失
    try {
      await renameWithRetry(backupDir, distDir, renameFn);
    } catch (rollbackErr) {
      console.error('== 回滚旧 dist 目录失败:', rollbackErr);
    }
    throw err;
  }

  try {
    rmFn(backupDir, { recursive: true, force: true });
  } catch {
    // 清理旧备份失败不影响新 dist 可用性
  }
}

function defaultTscRunner({ root, stagingDir }) {
  const result = spawnSync(
    process.execPath,
    [repoRunBin, 'tsc', '-p', 'tsconfig.json', '--outDir', stagingDir, '--noEmitOnError'],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error) {
    throw result.error;
  }
  return result.status === 0 && !result.signal;
}

/**
 * 先在同磁盘 .tmp 临时目录构建 TypeScript 与 CSS 产物，全部成功后原子替换 dist。
 * 构建失败时不修改既有 dist，并清理临时目录。
 */
export async function buildUi({
  root = pkgRoot,
  tscRunner = defaultTscRunner,
  copyCssFn = copyCss,
  renameFn = renameSync,
  rmFn = rmSync,
  existsFn = existsSync,
} = {}) {
  const tmpBase = join(root, '.tmp');
  mkdirSync(tmpBase, { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const stagingDir = join(tmpBase, `dist-staging-${suffix}`);
  const backupDir = join(tmpBase, `dist-backup-${suffix}`);
  const distDir = join(root, 'dist');
  const srcDir = join(root, 'src');

  mkdirSync(stagingDir, { recursive: true });

  const cleanupStaging = () => {
    try {
      if (existsFn(stagingDir)) {
        rmFn(stagingDir, { recursive: true, force: true });
      }
    } catch {
      // 忽略清理异常
    }
  };

  let abortedSignal = null;
  const onSignal = (sig) => {
    abortedSignal = sig;
    cleanupStaging();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const ok = await tscRunner({ root, stagingDir });
    if (!ok || abortedSignal) {
      return false;
    }

    await copyCssFn(srcDir, stagingDir);
    if (abortedSignal) {
      return false;
    }

    await replaceDirAtomically({
      stagingDir,
      distDir,
      backupDir,
      renameFn,
      rmFn,
      existsFn,
    });
    return true;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    cleanupStaging();
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isEntrypoint()) {
  const ok = await buildUi();
  if (!ok) process.exit(1);
}
