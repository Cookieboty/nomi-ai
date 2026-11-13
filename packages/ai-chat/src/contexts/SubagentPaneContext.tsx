/**
 * 子任务侧栏：主列留在来源对话，旁边打开另一份会话。
 * 三种会话都走同一块面板：
 * - harness：委派出去的编程助手标签（完整输入栏，按标签 id 绑定）；
 * - nested：进程内子代理（Task / spawn_agent），步骤来自父转录；
 * - nomi-task：delegate_to_nomi 的后台 Nomi 任务。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { useHarnessTabs } from './HarnessTabsContext';

export type SubagentTarget =
  | { kind: 'harness'; tabId: string }
  | { kind: 'nested'; callId: string; parentTabId: string | null }
  | { kind: 'nomi-task'; taskId: string };

interface SubagentPaneValue {
  /** 正在侧栏里看的会话；null = 没开 */
  target: SubagentTarget | null;
  /** harness 会话的标签 id（其它种类为 null）。会话详情的探针和旧调用用这个。 */
  tabId: string | null;
  openSubagent: (tabId: string) => void;
  openNested: (callId: string, parentTabId: string | null) => void;
  openNomiTask: (taskId: string) => void;
  closeSubagent: () => void;
}

const Ctx = createContext<SubagentPaneValue | null>(null);

export const SubagentPaneProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const tabs = useHarnessTabs();
  const [target, setTarget] = useState<SubagentTarget | null>(null);
  const tabId = target?.kind === 'harness' ? target.tabId : null;
  const openSubagent = useCallback((id: string) => {
    if (id) setTarget({ kind: 'harness', tabId: id });
  }, []);
  const openNested = useCallback((callId: string, parentTabId: string | null) => {
    if (callId) setTarget({ kind: 'nested', callId, parentTabId });
  }, []);
  const openNomiTask = useCallback((taskId: string) => {
    if (taskId) setTarget({ kind: 'nomi-task', taskId });
  }, []);
  const closeSubagent = useCallback(() => setTarget(null), []);

  // 委派标签被关掉：侧栏跟着关。不切换主列的当前标签。
  useEffect(() => {
    if (target?.kind !== 'harness' || !tabs.state) return;
    // 标签列表来自内核：标签没了就关掉侧栏
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 同步外部标签列表
    if (!tabs.state.tabs.some((tab) => tab.id === target.tabId)) setTarget(null);
  }, [target, tabs.state]);

  const value = useMemo(
    () => ({ target, tabId, openSubagent, openNested, openNomiTask, closeSubagent }),
    [target, tabId, openSubagent, openNested, openNomiTask, closeSubagent],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

/** 没有 Provider（单测 / 别的窗口）时返回 null：调用方退回原来的抽屉 */
export function useSubagentPane(): SubagentPaneValue | null {
  return useContext(Ctx);
}
