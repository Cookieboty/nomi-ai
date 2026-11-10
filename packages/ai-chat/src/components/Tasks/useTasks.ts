import { useCallback, useEffect, useState } from 'react';

import { tasksApi, tasksAvailable, type LegacyItem, type Task } from '../../services/tasksClient';

/** 任务列表：拉一次并跟着 tasks.changed 刷新 */
export function useTasks(enabled = true) {
  const [data, setData] = useState<{ tasks: Task[]; legacy: LegacyItem[] } | null>(null);
  const load = useCallback(() => {
    if (!tasksAvailable()) return;
    void tasksApi
      .list()
      .then(setData)
      .catch(() => setData({ tasks: [], legacy: [] }));
  }, []);
  useEffect(() => {
    if (!enabled || !tasksAvailable()) return;
    load();
    return tasksApi.onChange(load);
  }, [enabled, load]);
  return { data, reload: load };
}
