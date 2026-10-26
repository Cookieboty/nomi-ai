/**
 * 工作目录与上游的差距（右栏「改动」分支栏用，docs/design/changes-panel-git.md §3）：
 * 换目录、这一轮跑完、窗口重新拿到焦点、nonce 变化时重读。只读本地已知的远端分支，要新的先「检查远端」。
 * 不是 git 仓库、主进程没有这个接口时返回 null。
 */
import { useEffect, useState } from 'react';

import { harnessClient, type GitSyncStatus } from '../services/harnessClient';

export function useGitSync(cwd: string | null | undefined, running = false, nonce = 0) {
  const [st, setSt] = useState<{ cwd: string; status: GitSyncStatus | null } | null>(null);
  useEffect(() => {
    if (!cwd || running) return;
    let alive = true;
    const load = () =>
      void Promise.resolve()
        .then(() => harnessClient.gitSyncStatus(cwd))
        .then((status) => alive && setSt({ cwd, status }))
        .catch(() => alive && setSt({ cwd, status: null }));
    load();
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.removeEventListener('focus', load);
    };
  }, [cwd, running, nonce]);
  return cwd && st?.cwd === cwd ? st.status : null;
}
