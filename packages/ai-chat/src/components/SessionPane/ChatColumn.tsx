/**
 * 主对话列的**外壳**：`.chat-column` 的类名、`data-empty`、与 SideWorkspace 分栏时的宽度约束。
 *
 * 从 App.tsx 原样拆出来，DOM 与类名都不变（单面板时就是原来那一列：「对话与中栏」拖拽、
 * 空会话居中、保活都照旧）。两个面板并排时，每个面板各渲染一份；里面的内容（对话头、待带入前文条、
 * 会话主体、输入框）由 App 放进来——那边的状态都来自「当前会话」，只有焦点面板 / 单面板才有。
 */
import React from 'react';

export interface ChatColumnProps {
  /** 整列共用的 DOM 节点（单面板与左面板永远是它：拖拽 / 保活按它找） */
  columnRef?: React.Ref<HTMLDivElement>;
  testId?: string;
  hidden?: boolean;
  /** 空会话：欢迎区 + 输入框整块居中（App.css 的 [data-empty]） */
  empty?: boolean;
  /** 与 SideWorkspace 分栏：给对话列最小宽度（窗口窄时随窗口收缩） */
  withSidePane?: boolean;
  /** 覆盖最小宽度（并排会话时每一列更窄） */
  minWidth?: string;
  children: React.ReactNode;
}

export const chatColumnClassName = (opts: { withSidePane?: boolean }): string =>
  `chat-column${opts.withSidePane ? ' chat-column--split' : ''}`;

export const ChatColumn: React.FC<ChatColumnProps> = ({
  columnRef,
  testId = 'chat-column',
  hidden,
  empty,
  withSidePane,
  minWidth,
  children,
}) => (
  <div
    ref={columnRef}
    className={chatColumnClassName({ withSidePane })}
    data-testid={testId}
    data-empty={empty ? 'true' : undefined}
    hidden={hidden}
    style={
      minWidth ? { minWidth } : withSidePane ? { minWidth: 'var(--cd-chat-col-min)' } : undefined
    }
  >
    {children}
  </div>
);
