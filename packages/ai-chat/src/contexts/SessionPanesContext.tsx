/**
 * 主区的会话面板：侧栏单击 / 「向右打开」/ 关闭 / 拖动比例。
 *
 * - 只放状态与操作（纯函数在 utils/sessionPanes）：App 按它渲染 1~2 个会话面板，
 *   文件区（SideWorkspace）仍是 App 里的唯一一份，不属于任何面板；
 * - 焦点面板是「当前会话」：App 把 ConversationStore.currentId / harness.activeTabId 同步到它，
 *   因此发送、斜杠命令、工作区标签沿用现有按「当前会话」的那套路径；其余面板按自己的
 *   sessionKey 读消息，不随 current 变化被替换；
 * - 侧栏单击会话、右键「向右打开」、面板标题栏的拆分 / 关闭都经这里改状态；
 * - 拆分（两个面板各是哪个会话）与左右比例记在 localStorage，重启后会话还在就恢复拆分。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  persistPaneRatio,
  persistPaneSplit,
  readPaneRatio,
  readPaneSplit,
} from '../services/sessionPanePrefs';
import {
  closePane as closePaneState,
  collapseSplit as collapseSplitState,
  dropSession as dropSessionState,
  focusPane as focusPaneState,
  focusedPane,
  openSessionInFocus as openSessionInFocusState,
  openSessionOnSide as openSessionOnSideState,
  openSessionToSide as openSessionToSideState,
  PANE_RATIO_DEFAULT,
  paneForSession,
  paneKeysKey,
  setPaneSession as setPaneSessionState,
  singlePaneFor,
  syncExternalSession as syncExternalSessionState,
  type SessionPane,
  type SessionPaneSide,
  type SessionPanesState,
} from '../utils/sessionPanes';

export interface SessionPanesValue {
  panes: readonly SessionPane[];
  focusedPaneId: string;
  /** 焦点面板绑定的会话键 */
  focusedKey: string | null;
  /** 左右比例（左面板占的份额） */
  ratio: number;
  setRatio: (r: number) => void;
  /** 两个面板并排中 */
  isSplit: boolean;
  paneFor: (sessionKey: string | null) => SessionPane | undefined;
  /** 让某个面板获得焦点（焦点面板的会话成为当前会话） */
  focusPane: (paneId: string) => void;
  /** 只改某一个面板的会话 */
  setPaneSession: (paneId: string, sessionKey: string | null) => void;
  /** 侧栏单击：已开在某面板就聚焦它，否则换掉焦点面板 */
  openSessionInFocus: (sessionKey: string | null) => void;
  /** 「向右打开」：右面板打开这个会话 */
  openToSide: (sessionKey: string | null) => void;
  /** 拖放打开到主区左半或右半 */
  openOnSide: (sessionKey: string | null, side: SessionPaneSide) => void;
  /** 关掉一个面板（剩下的铺满主对话列） */
  closePane: (paneId: string) => void;
  /** 取消拆分：只留焦点面板 */
  leaveSplit: () => void;
  /** 会话关掉后把它从面板里摘掉（单面板时留一个空会话） */
  dropSession: (sessionKey: string) => void;
  /** 冷启动时：单面板指向这个会话（已打开在某个面板里时不动） */
  seed: (sessionKey: string | null) => void;
  /** 运行中外部会话切换（新建 / 灵动岛跳转等）：聚焦已有面板或替换焦点面板，保持拆分 */
  syncExternal: (sessionKey: string | null) => void;
}

export const SessionPanesContext = createContext<SessionPanesValue | null>(null);

const DEFAULT_STATE: SessionPanesState = {
  panes: [{ id: 'pane-a', sessionKey: null }],
  focusedPaneId: 'pane-a',
};

const initialFromPrefs = (): SessionPanesState => {
  const split = readPaneSplit();
  if (!split) return DEFAULT_STATE;
  return {
    panes: [
      { id: 'pane-a', sessionKey: split.left },
      { id: 'pane-b', sessionKey: split.right },
    ],
    focusedPaneId: 'pane-a',
  };
};

export interface SessionPanesProviderProps {
  children: React.ReactNode;
  /** 覆盖初始状态（测试 / 关闭恢复） */
  initial?: SessionPanesState;
  /** 初始比例（缺省从 localStorage 读） */
  initialRatio?: number;
  /** 读写 localStorage（默认是；测试里可关掉） */
  persist?: boolean;
  /** 焦点面板的会话变了：App 把「当前会话」同步到它（单面板时也走这里） */
  onFocusSession?: (sessionKey: string | null, paneId: string) => void;
  /** 面板列表变了（App 在会话被删 / 标签关掉时摘面板） */
  onPanesChange?: (panes: readonly SessionPane[]) => void;
}

export const SessionPanesProvider: React.FC<SessionPanesProviderProps> = ({
  children,
  initial,
  initialRatio,
  persist = true,
  onFocusSession,
  onPanesChange,
}) => {
  const [state, setState] = useState<SessionPanesState>(
    () => initial ?? (persist ? initialFromPrefs() : DEFAULT_STATE),
  );
  const [ratio, setRatioState] = useState<number>(
    () => initialRatio ?? (persist ? readPaneRatio() : PANE_RATIO_DEFAULT),
  );
  // 回调经 ref 读最新值：侧栏 / 菜单里的回调保持稳定。提交后再写（不在渲染时写 ref），
  // 与仓库里其它 Provider（AiChatContext / HarnessTabsContext）一致
  const focusRef = useRef(onFocusSession);
  useLayoutEffect(() => {
    focusRef.current = onFocusSession;
  });
  const panesRef = useRef(onPanesChange);
  useLayoutEffect(() => {
    panesRef.current = onPanesChange;
  });

  /** 所有改动都走这里：同步焦点会话、广播面板变化、按需落盘 */
  const apply = useCallback(
    (fn: (s: SessionPanesState) => SessionPanesState) => {
      setState((prev) => {
        const next = fn(prev);
        if (next === prev) return prev;
        if (paneKeysKey(next.panes) !== paneKeysKey(prev.panes)) {
          panesRef.current?.(next.panes);
          if (persist) persistPaneSplit(next.panes);
        }
        const focus = focusedPane(next);
        const before = focusedPane(prev);
        if (focus.sessionKey !== before.sessionKey || focus.id !== before.id)
          focusRef.current?.(focus.sessionKey, focus.id);
        return next;
      });
    },
    [persist],
  );

  const setRatio = useCallback(
    (r: number) => {
      setRatioState(r);
      if (persist) persistPaneRatio(r);
    },
    [persist],
  );

  // 各个动作引用稳定：拖动分割线改 ratio 时，Sidebar 等消费方不会因此失 memo
  const focusPane = useCallback((id: string) => apply((s) => focusPaneState(s, id)), [apply]);
  const setPaneSession = useCallback(
    (id: string, k: string | null) => apply((s) => setPaneSessionState(s, id, k)),
    [apply],
  );
  const openSessionInFocus = useCallback(
    (k: string | null) => apply((s) => openSessionInFocusState(s, k)),
    [apply],
  );
  const openToSide = useCallback(
    (k: string | null) => apply((s) => openSessionToSideState(s, k)),
    [apply],
  );
  const openOnSide = useCallback(
    (k: string | null, side: SessionPaneSide) => apply((s) => openSessionOnSideState(s, k, side)),
    [apply],
  );
  const closePane = useCallback((id: string) => apply((s) => closePaneState(s, id)), [apply]);
  const leaveSplit = useCallback(() => apply((s) => collapseSplitState(s)), [apply]);
  const dropSession = useCallback((k: string) => apply((s) => dropSessionState(s, k)), [apply]);
  const seed = useCallback((k: string | null) => apply((s) => singlePaneFor(s, k)), [apply]);
  const syncExternal = useCallback(
    (k: string | null) => apply((s) => syncExternalSessionState(s, k)),
    [apply],
  );
  const paneFor = useCallback((k: string | null) => paneForSession(state, k), [state]);

  const value = useMemo<SessionPanesValue>(() => {
    return {
      panes: state.panes,
      focusedPaneId: state.focusedPaneId,
      focusedKey: focusedPane(state).sessionKey,
      ratio,
      setRatio,
      isSplit: state.panes.length > 1,
      paneFor,
      focusPane,
      setPaneSession,
      openSessionInFocus,
      openToSide,
      openOnSide,
      closePane,
      leaveSplit,
      dropSession,
      seed,
      syncExternal,
    };
  }, [
    state,
    ratio,
    setRatio,
    paneFor,
    focusPane,
    setPaneSession,
    openSessionInFocus,
    openToSide,
    openOnSide,
    closePane,
    leaveSplit,
    dropSession,
    seed,
    syncExternal,
  ]);

  return <SessionPanesContext.Provider value={value}>{children}</SessionPanesContext.Provider>;
};

/** 会话面板状态；没有 Provider（独立渲染的控件 / 测试）时 undefined */
export function useSessionPanes(): SessionPanesValue | undefined {
  return useContext(SessionPanesContext) ?? undefined;
}
