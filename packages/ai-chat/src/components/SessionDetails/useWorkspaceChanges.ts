import { useEffect, useState } from 'react';

import { harnessClient, type GitSummaryResult } from '../../services/harnessClient';
import { onWindowFocus } from '../../utils/focusRefresh';
import { parseGitStatus } from '../../utils/gitStatusParse';
import type { ChangesSummary } from '../../utils/sessionChanges';

/** 一轮跑完 / 改了文件时接连触发：合并成一次读取 */
const DEBOUNCE_MS = 600;

/** git 的改动规模 → 文件数与增删行（工作区相对 HEAD；未跟踪的文件只计数） */
export function summarizeGit(r: GitSummaryResult): ChangesSummary | null {
  if (!r.ok) return null;
  return { files: parseGitStatus(r.status).length, added: r.added, removed: r.removed };
}

/** 同一目录同时只读一次：几个地方（主栏、浮层）同时要时共用进行中的请求 */
const inflight = new Map<string, Promise<GitSummaryResult>>();
function readSummary(cwd: string): Promise<GitSummaryResult> {
  let p = inflight.get(cwd);
  if (!p) {
    p = harnessClient.gitSummary(cwd).finally(() => inflight.delete(cwd));
    inflight.set(cwd, p);
  }
  return p;
}

/**
 * 会话详情的「变更」：工作区的 git 改动（委派出去的编程助手改的也算）。只取文件数与增删行
 * （harness.gitSummary，两条 git 命令），不取整份 diff。
 * 换目录、refreshKey 变化（新消息 / 一轮结束）时重读；窗口重新拿到焦点时至多每 5 秒重读一次。
 * 不是 git 仓库或读不到时返回 null，调用方退回本会话的改动。
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
        void readSummary(cwd)
          .then((r) => alive && setSt({ cwd, value: summarizeGit(r) }))
          .catch(() => alive && setSt({ cwd, value: null }));
      }, DEBOUNCE_MS);
    };
    read();
    const off = onWindowFocus(read);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      off();
    };
  }, [cwd, refreshKey]);
  return cwd && st?.cwd === cwd ? st.value : null;
}
