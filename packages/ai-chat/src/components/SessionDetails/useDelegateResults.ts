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

const MAX_CACHED_RESULTS = 500;
const cachedResults = new Map<string, DelegateResult>();
const cachedFollowUps = new Map<string, DelegateResult>();

function writeCache(map: Map<string, DelegateResult>, key: string, val: DelegateResult) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > MAX_CACHED_RESULTS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function readFromCache(
  map: Map<string, DelegateResult>,
  taskIds: readonly string[],
): Record<string, DelegateResult> {
  const out: Record<string, DelegateResult> = {};
  for (const id of taskIds) {
    const hit = map.get(id);
    if (hit) out[id] = hit;
  }
  return out;
}

/** 单测用：清空模块级终态结果缓存 */
export function resetDelegateResultsCache() {
  cachedResults.clear();
  cachedFollowUps.clear();
}

export function useDelegateResults(taskIds: readonly string[]): DelegateResults {
  const key = taskIds.join('\n');
  const [results, setResults] = useState<Record<string, DelegateResult>>(() =>
    readFromCache(cachedResults, taskIds),
  );
  const [followUps, setFollowUps] = useState<Record<string, DelegateResult>>(() =>
    readFromCache(cachedFollowUps, taskIds),
  );
  useEffect(() => {
    if (!key) return;
    const idsList = key.split('\n');
    setResults((prev) => {
      const fromCache = readFromCache(cachedResults, idsList);
      return Object.keys(fromCache).length ? { ...fromCache, ...prev } : prev;
    });
    setFollowUps((prev) => {
      const fromCache = readFromCache(cachedFollowUps, idsList);
      return Object.keys(fromCache).length ? { ...fromCache, ...prev } : prev;
    });
    if (!delegateClient.available()) return;
    const ids = new Set(idsList);
    let alive = true;
    const apply = (r: DelegateResult) => {
      if (!alive || !ids.has(r.taskId) || r.status === 'running') return;
      const cache = r.followUp ? cachedFollowUps : cachedResults;
      writeCache(cache, r.taskId, r);
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
