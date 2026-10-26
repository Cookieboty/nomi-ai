/** 右栏「改动」的 worktree 辅助（docs/design/changes-panel-git.md §5） */
import type { GitWorktree } from '../services/harnessClient';

/** 比较用：斜杠统一、去尾斜杠；macOS 的 /private/var、/private/tmp 与 /var、/tmp 是同一处 */
const norm = (p: string) =>
  p
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/^\/private(?=\/(var|tmp)\/)/, '');

const isAbs = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

/** 文件所在的 worktree：路径前缀最长的那个（委派目录 .nomi-delegate/<id> 就在主工作区里面） */
export function worktreeOf(
  file: string,
  worktrees: readonly GitWorktree[],
): GitWorktree | undefined {
  if (!isAbs(file)) return undefined;
  const f = norm(file);
  let best: GitWorktree | undefined;
  for (const w of worktrees) {
    const p = norm(w.path);
    if ((f === p || f.startsWith(`${p}/`)) && (!best || p.length > norm(best.path).length))
      best = w;
  }
  return best;
}

export const samePath = (a: string, b: string) => norm(a) === norm(b);

/** 本会话改过、但落在别的 worktree（不是正在看的这个）里的文件数，按 worktree 分 */
export function editsElsewhere(
  files: readonly string[],
  worktrees: readonly GitWorktree[],
  viewing: string,
): Array<{ worktree: GitWorktree; count: number }> {
  const counts = new Map<GitWorktree, number>();
  for (const f of files) {
    const w = worktreeOf(f, worktrees);
    if (w && !samePath(w.path, viewing)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts].map(([worktree, count]) => ({ worktree, count }));
}

/** 下拉框里的名字：目录名 · 分支（游离 HEAD 时短提交号） */
export function worktreeLabel(w: GitWorktree): string {
  const name = norm(w.path).split('/').pop() || w.path;
  const ref = w.branch ?? w.head?.slice(0, 7) ?? '';
  return ref ? `${name} · ${ref}` : name;
}
