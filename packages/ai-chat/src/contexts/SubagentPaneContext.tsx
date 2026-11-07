/**
 * 子任务面板（Nomi 委派出去的编程助手标签）：在对话旁边打开，不弹窗。
 * 与「变更 / 文件」查看区独立：各自的状态，子任务面板开着时占对话旁的那一栏，关掉后回到原来的查看区。
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

interface SubagentPaneValue {
  /** 打开着的子任务标签 id；null = 没开 */
  tabId: string | null;
  openSubagent: (tabId: string) => void;
  closeSubagent: () => void;
}

const Ctx = createContext<SubagentPaneValue | null>(null);

export const SubagentPaneProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [tabId, setTabId] = useState<string | null>(null);
  const openSubagent = useCallback((id: string) => setTabId(id), []);
  const closeSubagent = useCallback(() => setTabId(null), []);
  const value = useMemo(
    () => ({ tabId, openSubagent, closeSubagent }),
    [tabId, openSubagent, closeSubagent],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

/** 没有 Provider（单测 / 别的窗口）时返回 null：调用方退回原来的抽屉 */
export function useSubagentPane(): SubagentPaneValue | null {
  return useContext(Ctx);
}
