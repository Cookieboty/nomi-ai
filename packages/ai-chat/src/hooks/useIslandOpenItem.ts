import { useEffect } from 'react';

import { useHarnessTabsCore } from '../contexts/HarnessTabsContext';
import { desktopClient } from '../services/desktopClient';
import { MAIN_TAB_ID, harnessClient } from '../services/harnessClient';

/**
 * 灵动岛上点「打开」/ 点某一条（`nav.openItemRequested`）：任务 → 任务详情；agent 的请求 → 切到工坊里那个标签；
 * Nomi 的确认 / 通知 → 主对话（或指定会话）。openTask / leavePage 来自主区整页与设置页。
 */
export function useIslandOpenItem(
  openTask: ((id: string) => void) | undefined,
  leavePage: () => void,
  openConversation?: (id: string) => void,
  onOpenTab?: (tabId: string) => void,
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
          if (id) {
            void tabs.activate(id);
            onOpenTab?.(id);
          }
          return;
        }
        // 问题卡或指定对话通知把对话 id 放在 nomi 的 id 上：先同步更新会话指针再切回主标签，避免恢复到上一个会话
        if (target === 'nomi' && id) openConversation?.(id);
        if (tabs.isCliTab) void tabs.activate(MAIN_TAB_ID);
        if (
          tabs.activeTab?.id === MAIN_TAB_ID &&
          tabs.activeTab.backend !== 'nomi' &&
          harnessClient.available()
        ) {
          void harnessClient.setBackend('nomi').catch(() => undefined);
        }
      }),
    [openTask, leavePage, openConversation, onOpenTab, tabs],
  );
}
