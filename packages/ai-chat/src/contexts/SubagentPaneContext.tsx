/**
 * 子任务导航：Nomi 委派出去的编程助手标签，点「查看」后成为当前标签，
 * 主对话列用和普通编程助手会话同一套会话视图与输入栏。
 * 返回时切回打开它之前的标签（通常是 Nomi 主对话）。不另做一套输入队列。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { MAIN_TAB_ID } from '../services/harnessClient';

import { useHarnessTabs } from './HarnessTabsContext';

interface SubagentPaneValue {
  /** 正在主对话列里查看的子任务标签；null = 在来源会话 */
  tabId: string | null;
  /** 打开子任务之前的标签，返回时切回去 */
  returnTo: string | null;
  openSubagent: (tabId: string) => void;
  closeSubagent: () => void;
}

const Ctx = createContext<SubagentPaneValue | null>(null);

export const SubagentPaneProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const tabs = useHarnessTabs();
  const [tabId, setTabId] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const tabIdRef = useRef<string | null>(null);
  const returnToRef = useRef<string | null>(null);
  const activeRef = useRef(MAIN_TAB_ID);
  const activateRef = useRef(tabs.activate);
  /** 打开 / 关闭各算一代：过期的 activate 结果不再把返回栏拉回来 */
  const epochRef = useRef(0);
  /** activate 已经落地到这个标签上：之后 active 被改掉，就是用户从侧栏或快捷键离开 */
  const confirmedRef = useRef(false);
  /** 正在把 active 切到这个 id，避免标签广播把乐观更新冲掉时连着再切一次 */
  const activatingRef = useRef<string | null>(null);
  /** 标签列表还没到时 activate 落空：有限次再试，避免和内核对打 */
  const retriesRef = useRef(0);

  useLayoutEffect(() => {
    tabIdRef.current = tabId;
    returnToRef.current = returnTo;
    activeRef.current = tabs.state?.activeTabId ?? MAIN_TAB_ID;
    activateRef.current = tabs.activate;
  });

  const activateTabRef = useRef<(id: string, epoch: number) => void>(() => undefined);
  const activateTab = useCallback((id: string, epoch: number) => {
    activatingRef.current = id;
    void activateRef
      .current(id)
      .catch(() => undefined)
      .finally(() => {
        if (epochRef.current !== epoch) return;
        if (activatingRef.current === id) activatingRef.current = null;
        if (activeRef.current === id) {
          confirmedRef.current = true;
          retriesRef.current = 0;
          return;
        }
        // 打开时标签列表可能还没到，乐观更新落空；列表随后到达会再走 effect
        if (tabIdRef.current === id && retriesRef.current < 3) {
          retriesRef.current += 1;
          activateTabRef.current(id, epoch);
        }
      });
  }, []);
  useLayoutEffect(() => {
    activateTabRef.current = activateTab;
  });

  const closeSubagent = useCallback(() => {
    const back = returnToRef.current ?? MAIN_TAB_ID;
    epochRef.current += 1;
    confirmedRef.current = false;
    activatingRef.current = null;
    setTabId(null);
    setReturnTo(null);
    if (activeRef.current !== back) void activateRef.current(back).catch(() => undefined);
  }, []);

  const openSubagent = useCallback(
    (id: string) => {
      if (!id) return;
      const epoch = epochRef.current + 1;
      epochRef.current = epoch;
      confirmedRef.current = false;
      retriesRef.current = 0;
      setReturnTo((prev) => {
        const viewing = tabIdRef.current;
        if (viewing && viewing !== id) return prev ?? MAIN_TAB_ID;
        const active = activeRef.current;
        if (active === id) return prev ?? MAIN_TAB_ID;
        return active;
      });
      setTabId(id);
      activateTab(id, epoch);
    },
    [activateTab],
  );

  useEffect(() => {
    const id = tabId;
    const state = tabs.state;
    if (!id || !state) return;
    if (!state.tabs.some((tab) => tab.id === id)) {
      // 标签列表是内核状态：标签没了就离开，不能在渲染期切标签
      // eslint-disable-next-line react-hooks/set-state-in-effect -- closeSubagent 会 setState
      closeSubagent();
      return;
    }
    if (state.activeTabId === id) return;
    // 还在等这一次打开落地：过期的标签广播先别当成「用户离开」
    if (!confirmedRef.current) {
      if (activatingRef.current !== id) activateTab(id, epochRef.current);
      return;
    }
    // 侧栏、快捷键等已经把当前标签切走：收起返回栏，不再把 active 拽回来
    confirmedRef.current = false;
    activatingRef.current = null;
    setTabId(null);
    setReturnTo(null);
  }, [tabId, tabs.state, closeSubagent, activateTab]);

  const value = useMemo(
    () => ({ tabId, returnTo, openSubagent, closeSubagent }),
    [tabId, returnTo, openSubagent, closeSubagent],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

/** 没有 Provider（单测 / 别的窗口）时返回 null：调用方退回原来的抽屉 */
export function useSubagentPane(): SubagentPaneValue | null {
  return useContext(Ctx);
}
