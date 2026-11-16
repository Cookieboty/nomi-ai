import { useEffect, useMemo, useState } from 'react';

import { delegateClient, type DelegateResult } from '../../services/delegateClient';

/**
 * 异步委派的最终结果（taskId → 结果）：先查一次 delegate.status，之后跟着 delegate.completed 更新。
 * 与子任务卡片同一来源；会话详情靠它把已经结束的委派显示成已完成 / 出错，而不是一直「运行中」。
 */
export interface DelegateResults {
  /** 委派本身的最终结果 */
  results: Record<string, DelegateResult>;
  /** 委派结束后在子任务里接着跑的一轮（出错后「继续」、接着对话）的最新结果 */
  followUps: Record<string, DelegateResult>;
}

export function useDelegateResults(taskIds: readonly string[]): DelegateResults {
  const [results, setResults] = useState<Record<string, DelegateResult>>({});
  const [followUps, setFollowUps] = useState<Record<string, DelegateResult>>({});
  const key = taskIds.join('\n');
  useEffect(() => {
    if (!key || !delegateClient.available()) return;
    const ids = new Set(key.split('\n'));
    let alive = true;
    const apply = (r: DelegateResult) => {
      if (!alive || !ids.has(r.taskId) || r.status === 'running') return;
      const set = r.followUp ? setFollowUps : setResults;
      set((m) => (m[r.taskId] === r ? m : { ...m, [r.taskId]: r }));
    };
    const off = delegateClient.onCompleted(apply);
    for (const id of ids) {
      void delegateClient
        .status(id)
        .then((r) => {
          if (r) apply(r);
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
      off();
    };
  }, [key]);
  return useMemo(() => ({ results, followUps }), [results, followUps]);
}
