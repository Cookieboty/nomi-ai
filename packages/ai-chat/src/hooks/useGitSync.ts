/**
 * 右栏「改动」分支栏的 git 信息（docs/design/changes-panel-git.md §3、§5）：与上游的差距、同一仓库的 worktree。
 * 换目录、这一轮跑完、窗口重新拿到焦点、nonce 变化时重读。ahead / behind 只按本地已知的远端分支算，要新的先「检查远端」。
 * 不是 git 仓库、主进程没有这个接口时返回 null。
 */
import { useEffect, useState } from 'react';

import { harnessClient, type GitSyncStatus, type GitWorktreeList } from '../services/harnessClient';

function useGitInfo<T>(
  load: (cwd: string) => Promise<T | null>,
  cwd: string | null | undefined,
  running: boolean,
  nonce: number,
): T | null {
  const [st, setSt] = useState<{ cwd: string; value: T | null } | null>(null);
  useEffect(() => {
    if (!cwd || running) return;
    let alive = true;
    const read = () =>
      void Promise.resolve()
        .then(() => load(cwd))
        .then((value) => alive && setSt({ cwd, value }))
        .catch(() => alive && setSt({ cwd, value: null }));
    read();
    window.addEventListener('focus', read);
    return () => {
      alive = false;
      window.removeEventListener('focus', read);
    };
  }, [load, cwd, running, nonce]);
  return cwd && st?.cwd === cwd ? st.value : null;
}

const loadSync = (cwd: string) => harnessClient.gitSyncStatus(cwd);
const loadWorktrees = (cwd: string) => harnessClient.gitWorktrees(cwd);

export function useGitSync(cwd: string | null | undefined, running = false, nonce = 0) {
  return useGitInfo<GitSyncStatus>(loadSync, cwd, running, nonce);
}

export function useGitWorktrees(cwd: string | null | undefined, running = false, nonce = 0) {
  return useGitInfo<GitWorktreeList>(loadWorktrees, cwd, running, nonce);
}
