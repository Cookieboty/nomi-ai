import { useEffect, useState } from 'react';

import { harnessClient, type GitDiffResult } from '../../services/harnessClient';
import { parseGitStatus } from '../../utils/gitStatusParse';
import type { ChangesSummary } from '../../utils/sessionChanges';

/** 一轮跑完 / 改了文件时接连触发：合并成一次 git diff */
const DEBOUNCE_MS = 600;

/** git diff 的结果 → 文件数与增删行（工作区相对 HEAD；未跟踪的文件只计数） */
export function summarizeGit(r: GitDiffResult): ChangesSummary | null {
  if (!r.ok) return null;
  const files = parseGitStatus(r.status).length;
  let added = 0;
  let removed = 0;
  for (const n of Object.values(r.numstat?.head ?? {})) {
    added += n.added;
    removed += n.removed;
  }
  return { files, added, removed };
}

/**
 * 会话详情的「变更」：工作区的 git 改动（与右栏「改动」同一来源，委派出去的编程助手改的也算）。
 * 换目录、refreshKey 变化（新消息 / 一轮结束）、窗口重新拿到焦点时重读；不是 git 仓库或读不到时返回 null，调用方退回本会话的改动。
 */
export function useWorkspaceChanges(
  cwd: string | null,
  refreshKey: unknown,
): ChangesSummary | null {
  const [st, setSt] = useState<{ cwd: string; value: ChangesSummary | null } | null>(null);
  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    let timer = 0;
    const read = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void harnessClient
          .gitDiff(cwd)
          .then((r) => alive && setSt({ cwd, value: summarizeGit(r) }))
          .catch(() => alive && setSt({ cwd, value: null }));
      }, DEBOUNCE_MS);
    };
    read();
    window.addEventListener('focus', read);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener('focus', read);
    };
  }, [cwd, refreshKey]);
  return cwd && st?.cwd === cwd ? st.value : null;
}
