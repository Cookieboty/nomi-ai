/**
 * 新建 CLI 标签 / 对话 / 分叉时的初始工作目录：默认沿用当前标签的目录，用户改过则用用户选的。
 */
import { useCallback, useState } from 'react';

import { useHarnessTabsCore } from '../contexts/HarnessTabsContext';

export function useNewWorkspace(): {
  /** 当前显示的目录（用户选的，否则默认） */
  cwd: string;
  /** 用户明确选过时才有值；未选时传 undefined 让主进程用默认目录 */
  chosen: string | undefined;
  set: (cwd: string) => void;
  reset: () => void;
} {
  const tabs = useHarnessTabsCore();
  const [chosen, setChosen] = useState<string | undefined>();
  const fallback = tabs.activeTab?.cwd ?? '';
  const set = useCallback((cwd: string) => setChosen(cwd), []);
  const reset = useCallback(() => setChosen(undefined), []);
  return { cwd: chosen ?? fallback, chosen, set, reset };
}
