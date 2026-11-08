/**
 * 子任务面板（Nomi 委派出去的编程助手标签）：在对话旁边打开，不弹窗。
 * 与「变更 / 文件」查看区独立：各自的状态，子任务面板开着时占对话旁的那一栏，关掉后回到原来的查看区。
 * 草稿与待发消息按标签放在这里（subagentQueue），切换 / 关掉面板不会串到别的标签，也不会丢。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

import { harnessClient } from '../services/harnessClient';

import { useHarnessTabs } from './HarnessTabsContext';
import { createSubagentQueue, type SubagentQueue } from './subagentQueue';

interface SubagentPaneValue {
  /** 打开着的子任务标签 id；null = 没开 */
  tabId: string | null;
  openSubagent: (tabId: string) => void;
  closeSubagent: () => void;
  /** 各子任务标签的草稿与待发消息 */
  queue: SubagentQueue;
}

const Ctx = createContext<SubagentPaneValue | null>(null);

/** sendTab 出错后：最后一条用户消息就是这条、且是这次发出之后写进去的，说明内核已接收 */
async function acceptedByTab(tabId: string, text: string, since: number): Promise<boolean> {
  const messages = await harnessClient.tabMessages(tabId);
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return !!last && last.content.trim() === text && last.timestamp >= since;
}

export const SubagentPaneProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [tabId, setTabId] = useState<string | null>(null);
  const [queue] = useState(() =>
    createSubagentQueue({
      send: (id, text) => harnessClient.sendTab(id, text),
      steer: (id, text) => harnessClient.steerTab(id, text),
      accepted: acceptedByTab,
    }),
  );
  const tabsState = useHarnessTabs().state;
  // 提交后、用户能操作前同步标签状态：插话 / 排队按最新状态判断
  useLayoutEffect(() => {
    if (tabsState) queue.sync(tabsState.tabs);
  }, [queue, tabsState]);
  const openSubagent = useCallback((id: string) => setTabId(id), []);
  const closeSubagent = useCallback(() => setTabId(null), []);
  const value = useMemo(
    () => ({ tabId, openSubagent, closeSubagent, queue }),
    [tabId, openSubagent, closeSubagent, queue],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

/** 没有 Provider（单测 / 别的窗口）时返回 null：调用方退回原来的抽屉 */
export function useSubagentPane(): SubagentPaneValue | null {
  return useContext(Ctx);
}
