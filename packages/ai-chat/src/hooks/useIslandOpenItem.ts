import { useEffect } from 'react';

import { useHarnessTabsCore } from '../contexts/HarnessTabsContext';
import { desktopClient } from '../services/desktopClient';

/**
 * 灵动岛上点「打开」/ 点某一条（`nav.openItemRequested`）：任务 → 任务详情；编程助手的请求 → 切到工坊里那个标签；
 * Nomi 的确认 → 主对话。openTask / leavePage 来自主区整页（useMainPages）。
 */
export function useIslandOpenItem(
  openTask: ((id: string) => void) | undefined,
  leavePage: () => void,
): void {
  const tabs = useHarnessTabsCore();
  useEffect(
    () =>
      desktopClient.onOpenItem(({ target, id }) => {
        if (target === 'task') {
          if (openTask) openTask(id);
          return;
        }
        leavePage();
        if (target === 'tab' && tabs.available) {
          void tabs.activate(id);
        } else if (tabs.isCliTab) {
          void tabs.activate('main');
        }
      }),
    [openTask, leavePage, tabs],
  );
}
