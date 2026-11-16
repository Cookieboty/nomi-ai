/**
 * 子任务 / 侧边聊天面板在标签区里的外框。
 *
 * 标签区（SideWorkspace）里，名字、运行状态在标签上，关闭在标签的 ×，停止在输入栏的停止键，
 * 面板顶上再画一行头就把会话整体压低一截，和左边主对话（顶上没有头）对不齐。
 * 所以在标签区里不画面板头：任务目标和提示收成一小段，放在输入框上方（像主列输入框上方的上下文条）。
 * 独立窗口 / 单独使用时（没有标签栏）仍是原来的面板头。
 */
import React from 'react';

import styles from './SubagentPane.module.css';

const InTabStripCtx = React.createContext(false);

/** SideWorkspace 包在标签区主体外：里面的面板不再画自己的头 */
export const InTabStripProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <InTabStripCtx.Provider value>{children}</InTabStripCtx.Provider>
);

export const useInTabStrip = () => React.useContext(InTabStripCtx);

/** 面板的说明文字：标签区外画在面板头下面，标签区里收进输入框上方 */
export interface PaneNotes {
  /** 任务目标（委派时的 goal / 进度） */
  goal?: string;
  hint?: string;
  hintTestId?: string;
  /** 临时通知（role=status） */
  notice?: string | null;
}

/** 标签区里输入框上方的一小段：任务目标（一行，悬停看全文）+ 提示 + 通知 */
export const PaneBrief: React.FC<PaneNotes> = ({ goal, hint, hintTestId, notice }) => {
  if (!goal && !hint && !notice) return null;
  return (
    <div className={styles.brief} data-testid="subagent-brief">
      {goal && (
        <p className={styles.briefGoal} title={goal} data-testid="subagent-goal">
          {goal}
        </p>
      )}
      {hint && (
        <p className={styles.briefHint} data-testid={hintTestId}>
          {hint}
        </p>
      )}
      {notice && (
        <p className={styles.briefHint} data-testid="subagent-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
};
