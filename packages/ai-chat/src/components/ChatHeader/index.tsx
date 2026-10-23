/**
 * 对话窗口顶栏：只放与当前对话有关的东西——对话标签（工作台模式）与右侧的工作目录、变更栏开关等。
 * 应用级入口（设置 / 知识 · 记忆 · 日程 / 扩展 / 本机）在侧栏底部（AppEntries），
 * 助手 / 工作台切换在侧栏 Nomi 标志右侧。
 */
import React from 'react';

import styles from './index.module.css';

interface Props {
  /** 对话标签条（工作台模式） */
  tabs?: React.ReactNode;
  /** 右侧与当前对话有关的按钮（如变更栏开关） */
  trailing?: React.ReactNode;
  children?: React.ReactNode;
}

export const ChatHeader: React.FC<Props> = (p) => (
  <header
    className={styles.header}
    data-with-tabs={p.tabs ? 'true' : undefined}
    data-testid="chat-header"
  >
    {p.tabs && <div className={styles.tabsSlot}>{p.tabs}</div>}
    {p.children}
    {p.trailing && <div className={styles.actions}>{p.trailing}</div>}
  </header>
);
