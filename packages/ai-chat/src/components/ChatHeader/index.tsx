/**
 * 对话窗口顶栏：右侧放与当前会话有关的按钮（工作目录、改动栏开关等）。
 * 浏览器预览在左侧复用会话标题下拉，桌面窗口则放在一体化标题栏。
 */
import React from 'react';

import styles from './index.module.css';

interface Props {
  title?: React.ReactNode;
  /** 右侧与当前会话有关的按钮（如变更栏开关） */
  trailing?: React.ReactNode;
}

export const ChatHeader: React.FC<Props> = (p) => (
  <header className={styles.header} data-testid="chat-header">
    {p.title && <div className={styles.title}>{p.title}</div>}
    {p.trailing && <div className={styles.actions}>{p.trailing}</div>}
  </header>
);
