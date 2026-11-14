/**
 * 选中文字后的两个动作（对话 / 子任务 / 文件预览里共用，见 docs/design/side-tabs-workspace.md）：
 * - 「添加到对话」：把选区作为引用加到主会话的输入框上；
 * - 「在侧边聊天中提问」：开（或切到）侧边聊天标签，把选区带进去。
 * 由主窗口的 App 提供；没有 Provider（弹出窗口 / 单测）时为 null，调用方不显示这两个按钮。
 */
import { createContext, useContext } from 'react';

import type { SelectionQuote } from '../utils/selectionQuote';

export interface SelectionActions {
  addToChat: (quote: SelectionQuote) => void;
  askInSideChat: (quote: SelectionQuote) => void;
}

export const SelectionActionsContext = createContext<SelectionActions | null>(null);

export function useSelectionActions(): SelectionActions | null {
  return useContext(SelectionActionsContext);
}
