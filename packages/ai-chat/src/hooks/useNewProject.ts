/**
 * 新建对话 / 分叉时的初始项目：用户在菜单里选过就用选的，否则不指定（Nomi 对话沿用当前对话的项目，
 * 编程助手标签用默认目录）。
 */
import { useCallback, useState } from 'react';

export function useNewProject(): {
  /** 用户明确选过的项目；没选时 undefined */
  chosen: string | undefined;
  set: (projectId: string) => void;
  reset: () => void;
} {
  const [chosen, setChosen] = useState<string | undefined>();
  const set = useCallback((id: string) => setChosen(id), []);
  const reset = useCallback(() => setChosen(undefined), []);
  return { chosen, set, reset };
}
