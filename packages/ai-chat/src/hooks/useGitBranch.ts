/**
 * 工作目录的当前分支（只读，右栏「改动 · 文件」顶部用）：换目录、这一轮跑完（助手可能 checkout 过）、
 * 窗口重新拿到焦点、手动刷新（nonce 变化）时重读。不是 git 仓库 / 游离 HEAD 时分别返回 null / 短提交号。
 */
import { useEffect, useState } from 'react';

import { harnessClient } from '../services/harnessClient';

export function useGitBranch(cwd: string | null | undefined, running = false, nonce = 0) {
  const [st, setSt] = useState<{ cwd: string; label: string | null } | null>(null);
  useEffect(() => {
    if (!cwd || running) return;
    let alive = true;
    const load = () =>
      void harnessClient
        .gitBranch(cwd)
        .then((r) => {
          if (alive) setSt({ cwd, label: r ? (r.branch ?? r.detached ?? null) : null });
        })
        .catch(() => alive && setSt({ cwd, label: null }));
    load();
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.removeEventListener('focus', load);
    };
  }, [cwd, running, nonce]);
  return cwd && st?.cwd === cwd ? st.label : null;
}
