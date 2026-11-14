/**
 * 会话详情这一栏的开关状态：
 * - 用户的选择（开 / 关）记在本机；
 * - 展开了文件预览或 Diff（中栏）时自动收起，不管屏幕多宽；屏幕较窄（< 1440）时，文件栏、子任务侧栏展开也收起，
 *   给对话留地方；
 * - 这时点标题栏按钮可以手动再打开：以浮层盖在对话上方（不挤占对话），点浮层外面或 Esc 收回；
 *   那几栏开关有变化后又按自动规则来；
 * - 宽屏下文件栏 / 子任务侧栏展开时不收起，但也改成浮层盖在对话右上角，不挤压对话。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { useSubagentPane } from '../../contexts/SubagentPaneContext';
import { agentKey } from '../../utils/sideTabs';
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
  /** 用户开着，但因为展开了 Diff / 文件预览（或屏幕窄、别的栏展开）而自动收起了 */
  autoHidden: boolean;
  /** 以浮层盖在对话上方（自动收起后手动再打开，或旁边还开着文件栏 / 子任务栏） */
  floating: boolean;
  /** 浮层是自动收起后手动打开的：点外面收回 */
  dismissible: boolean;
  toggle: () => void;
  close: () => void;
  /** 收回浮层（回到自动收起，不改用户的开关选择） */
  dismiss: () => void;
  /** 文件栏开关（App 的状态，经标题栏按钮报上来） */
  setRailOpen: (open: boolean) => void;
}

const Ctx = createContext<DetailsValue | null>(null);

export const SessionDetailsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [pref, setPrefState] = useState(readOpen);
  const [override, setOverride] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const { workbench, previewOpen } = useChangesUi();
  const pane = useSubagentPane();
  const subagent = pane?.target ?? null;
  // 标签区开着（子任务或文件标签）就算占了对话旁那一栏
  const subagentOpen = (pane?.targets.length ?? 0) > 0 || !!pane?.filesOpen;
  const subKey = subagent ? agentKey(subagent) : '';
  const small = useMedia(SESSION_DETAILS_SMALL);
  const crowded = !!workbench || previewOpen || (small && (railOpen || subagentOpen));
  // 那几栏开关有变化（含子任务换了一个）：清掉手动打开，重新按自动规则（渲染期比对，不在 effect 里 setState）
  const layoutKey = `${small}|${railOpen}|${!!workbench}|${previewOpen}|${subKey}`;
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
  const dismissible = visible && crowded;
  const floating = visible && (crowded || railOpen || subagentOpen);
  const dismiss = useCallback(() => setOverride(false), []);
  const toggle = useCallback(() => {
    if (dismissible) return dismiss();
    if (visible) return close();
    setPref(true);
    setOverride(crowded);
  }, [dismissible, visible, crowded, close, dismiss, setPref]);

  const value = useMemo(
    () => ({
      visible,
      autoHidden: pref && !visible,
      floating,
      dismissible,
      toggle,
      close,
      dismiss,
      setRailOpen,
    }),
    [visible, pref, floating, dismissible, toggle, close, dismiss],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useSessionDetails(): DetailsValue | null {
  return useContext(Ctx);
}
