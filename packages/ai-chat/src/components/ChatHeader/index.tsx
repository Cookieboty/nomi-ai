/**
 * 对话窗口顶栏：右侧放与当前会话有关的按钮（工作目录、改动栏开关等）。
 * 会话切换在侧栏，这里不再显示会话标题；应用级入口（设置 / 知识 · 记忆 · 日程 / 扩展）在侧栏底部，
 * 助手 / 工作台切换在侧栏 Nomi 标志右侧。
 */
import React from 'react';

import styles from './index.module.css';

interface Props {
  /** 右侧与当前会话有关的按钮（如变更栏开关） */
  trailing?: React.ReactNode;
}

export const ChatHeader: React.FC<Props> = (p) => (
  <header className={styles.header} data-testid="chat-header">
    {p.trailing && <div className={styles.actions}>{p.trailing}</div>}
  </header>
);
