/**
 * 会话详情这一栏的开关状态：
 * - 用户的选择（开 / 关）记在本机；
 * - 屏幕较窄（< 1440）且对话旁已经展开了别的栏（文件栏、中栏 Diff / 文件预览、子任务面板）时自动收起，
 *   给对话留地方；这时点标题栏按钮可以手动再打开，那几栏开关有变化后又按自动规则来。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { useSubagentPane } from '../../contexts/SubagentPaneContext';
import { useChangesUi } from '../SessionWorkspace/ChangesUiContext';

const STORE_KEY = 'nomi.sessionDetails.open';
/** 小于这个宽度、又展开了别的栏时自动收起 */
export const SESSION_DETAILS_SMALL = '(max-width: 1439px)';

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) === '1';
  } catch {
    return false;
  }
}

function useMedia(query: string): boolean {
  const get = () => {
    try {
      return window.matchMedia?.(query).matches ?? false;
    } catch {
      return false;
    }
  };
  const [match, setMatch] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return match;
}

interface DetailsValue {
  /** 现在是否显示 */
  visible: boolean;
  /** 用户开着，但因为屏幕窄、别的栏展开而自动收起了 */
  autoHidden: boolean;
  toggle: () => void;
  close: () => void;
  /** 文件栏开关（App 的状态，经标题栏按钮报上来） */
  setRailOpen: (open: boolean) => void;
}

const Ctx = createContext<DetailsValue | null>(null);

export const SessionDetailsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [pref, setPrefState] = useState(readOpen);
  const [override, setOverride] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const { workbench, previewOpen } = useChangesUi();
  const subagentTab = useSubagentPane()?.tabId ?? null;
  const small = useMedia(SESSION_DETAILS_SMALL);
  const crowded = small && (railOpen || !!workbench || previewOpen || !!subagentTab);
  // 那几栏开关有变化（含子任务换了一个）：清掉手动打开，重新按自动规则（渲染期比对，不在 effect 里 setState）
  const layoutKey = `${small}|${railOpen}|${!!workbench}|${previewOpen}|${subagentTab ?? ''}`;
  const [prevKey, setPrevKey] = useState(layoutKey);
  if (prevKey !== layoutKey) {
    setPrevKey(layoutKey);
    if (override) setOverride(false);
  }
  const visible = pref && (!crowded || override);

  const setPref = useCallback((v: boolean) => {
    setPrefState(v);
    try {
      localStorage.setItem(STORE_KEY, v ? '1' : '0');
    } catch {
      /* 无痕窗口等：只在本次有效 */
    }
  }, []);
  const close = useCallback(() => {
    setPref(false);
    setOverride(false);
  }, [setPref]);
  const toggle = useCallback(() => {
    if (visible) return close();
    setPref(true);
    setOverride(crowded);
  }, [visible, crowded, close, setPref]);

  const value = useMemo(
    () => ({ visible, autoHidden: pref && !visible, toggle, close, setRailOpen }),
    [visible, pref, toggle, close],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useSessionDetails(): DetailsValue | null {
  return useContext(Ctx);
}
