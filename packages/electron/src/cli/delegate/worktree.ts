/**
 * P3 委派 OS 隔离（轻量）：git worktree，避免并行子任务改同一工作区。
 * 设计：docs/design/nomi-delegate-cli.md §9 P3。不做 Docker。
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 同时处于 running 的委派上限（含 worktree / shared-cwd） */
export const MAX_PARALLEL_DELEGATES = 3;

export type IsolationKind = 'worktree' | 'shared-cwd';

export interface IsolationHandle {
  kind: IsolationKind;
  /** 交给 createTab 的 cwd */
  cwd: string;
  /** 用户授权的原始目录 */
  sourceCwd: string;
  /** worktree 时的仓库根 */
  gitRoot?: string;
  /** worktree 路径（清理用） */
  worktreePath?: string;
  /** 短说明，写进结果 / 日志 */
  note: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[k];
  return env;
}

async function git(
  cwd: string,
  args: string[],
  opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: opts?.timeout ?? 30_000,
    env: gitEnv(),
  });
}

/** cwd 是否落在某个 git 仓库内；返回绝对路径的 toplevel，否则 null */
export async function resolveGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await git(cwd, ['rev-parse', '--show-toplevel']);
    const root = stdout.trim();
    if (!root) return null;
    const rel = path.relative(root, path.resolve(cwd));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return root;
  } catch {
    return null;
  }
}

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'task';
}

/** 把 info/exclude 加上 .nomi-delegate/，避免主工作区把隔离目录当未跟踪文件 */
export async function ensureDelegateExclude(gitRoot: string): Promise<void> {
  try {
    const { stdout } = await git(gitRoot, ['rev-parse', '--git-path', 'info/exclude']);
    const exclude = stdout.trim();
    if (!exclude) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const marker = '.nomi-delegate/';
    let cur = '';
    try {
      cur = fs.readFileSync(exclude, 'utf8');
    } catch {
      cur = '';
    }
    if (cur.split(/\r?\n/).some((l) => l.trim() === marker)) return;
    fs.appendFileSync(
      exclude,
      `${cur.endsWith('\n') || !cur ? '' : '\n'}# Nomi delegate worktrees\n${marker}\n`,
    );
  } catch {
    /* 非致命 */
  }
}

/**
 * 为一次委派准备隔离 cwd。
 * - 在 git 仓库内：新建 worktree（detached HEAD），路径 `<root>/.nomi-delegate/<id>`
 * - 非 git：沿用 sourceCwd，并注明并行会互相改文件
 */
export async function prepareIsolation(
  sourceCwd: string,
  taskKey: string,
): Promise<IsolationHandle> {
  const root = await resolveGitRoot(sourceCwd);
  if (!root) {
    return {
      kind: 'shared-cwd',
      cwd: sourceCwd,
      sourceCwd,
      note:
        '工作目录不是 git 仓库：委派在原目录运行。若并行多个子任务，它们会互相改同一批文件；' +
        '请串行委派，或先把该目录初始化为 git 仓库以便自动使用 worktree 隔离。',
    };
  }

  const id = safeId(taskKey);
  // 放在已授权的 sourceCwd 下，避免 PermissionBroker 拒掉仓库根下的路径
  const worktreePath = path.join(path.resolve(sourceCwd), '.nomi-delegate', id);
  await ensureDelegateExclude(root);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  if (fs.existsSync(worktreePath)) {
    try {
      await git(root, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      try {
        await git(root, ['worktree', 'prune']);
      } catch {
        /* ignore */
      }
    }
  }

  try {
    await git(root, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`无法创建委派 worktree：${msg}`, { cause: e });
  }

  return {
    kind: 'worktree',
    cwd: worktreePath,
    sourceCwd,
    gitRoot: root,
    worktreePath,
    note: `已在 git worktree 中隔离并行写入：${worktreePath}`,
  };
}

/** 结束后拆除 worktree；shared-cwd 无操作。失败只记日志不抛。 */
export async function releaseIsolation(
  handle: IsolationHandle | undefined,
  log?: (msg: string) => void,
): Promise<void> {
  if (!handle || handle.kind !== 'worktree' || !handle.worktreePath || !handle.gitRoot) return;
  const wt = handle.worktreePath;
  const root = handle.gitRoot;
  try {
    await git(root, ['worktree', 'remove', '--force', wt]);
  } catch (e) {
    log?.(
      `worktree remove failed: ${e instanceof Error ? e.message : String(e)}; falling back to rm`,
    );
    try {
      fs.rmSync(wt, { recursive: true, force: true });
      await git(root, ['worktree', 'prune']);
    } catch (e2) {
      log?.(`worktree cleanup failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  }
}

/**
 * 将 worktree 内相对仓库根的改动拷回主工作树，便于用户在原目录看到结果。
 * 主工作树已经有改动的路径会保留在 worktree 中并报告为冲突，避免覆盖用户或先完成任务的结果。
 */
export function applyWorktreeToMain(
  handle: IsolationHandle,
  changedRelPaths: string[],
): { applied: string[]; skipped: string[]; conflicted: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];
  const conflicted: string[] = [];
  if (handle.kind !== 'worktree' || !handle.worktreePath || !handle.gitRoot) {
    return { applied, skipped, conflicted };
  }
  for (const rel of changedRelPaths) {
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
      skipped.push(rel);
      continue;
    }
    // The worktree starts at HEAD. Never overwrite a file that the user changed
    // in the main worktree after the task was started; doing so would silently
    // destroy unrelated local work. The caller can surface conflicted files and
    // let the user merge them explicitly.
    if (!isMainPathClean(handle.gitRoot, rel)) {
      conflicted.push(rel);
      continue;
    }
    const src = path.join(handle.worktreePath, rel);
    const dest = path.join(handle.gitRoot, rel);
    try {
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        applied.push(rel);
      } else if (fs.existsSync(dest)) {
        fs.rmSync(dest, { force: true });
        applied.push(rel);
      } else {
        skipped.push(rel);
      }
    } catch {
      skipped.push(rel);
    }
  }
  return { applied, skipped, conflicted };
}

/** Return false when the destination path has staged, unstaged, or untracked changes. */
function isMainPathClean(gitRoot: string, rel: string): boolean {
  try {
    const { stdout } = requireGitStatus(gitRoot, rel);
    return !stdout.trim();
  } catch {
    // A failed status check is unsafe to treat as clean. Leave the file in the
    // worktree so the user can inspect and apply it manually.
    return false;
  }
}

function requireGitStatus(gitRoot: string, rel: string): { stdout: string } {
  return {
    stdout: execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', rel], {
      cwd: gitRoot,
      encoding: 'utf8',
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  };
}
