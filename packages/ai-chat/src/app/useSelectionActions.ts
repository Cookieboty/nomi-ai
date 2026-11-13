/**
 * 主窗口里「选中文字」的两个动作（SelectionActionsContext）：
 * - 添加到对话：引用加到主会话输入框（文件选区用文件链接：路径 + 行号）；铺满且不在主会话时先切到主会话；
 * - 在侧边聊天中提问：开（或切到）这个会话的侧边聊天标签，把选区带上。
 */
import { useMemo } from 'react';

import { useChangesUi } from '../components/SessionWorkspace';
import type { SelectionActions } from '../contexts/SelectionActionsContext';
import { useSubagentPane } from '../contexts/SubagentPaneContext';
import { addSideChatQuote } from '../services/sideChat';
import { quoteMarkdown, type SelectionQuote } from '../utils/selectionQuote';
import { MAIN_SIDE_TAB } from '../utils/sideTabs';

/** 「添加到对话」填进输入框的 Markdown：文件选区是链接（输入框里显示成文件胶囊），其余是引用块 */
export function selectionFill(quote: SelectionQuote): string {
  if (quote.href) {
    const label = quote.source.replace(/[\\[\]]/g, '\\$&');
    return `[${label}](${quote.href})\n\n`;
  }
  return `${quoteMarkdown(quote)}\n\n`;
}

export function useSelectionActions(side: { maximized: boolean }): SelectionActions {
  const { fillComposer } = useChangesUi();
  const pane = useSubagentPane();
  const scope = pane?.scope ?? '';
  const activate = pane?.activate;
  const openSideChat = pane?.openSideChat;
  const maximized = side.maximized;
  return useMemo(
    () => ({
      addToChat: (quote) => {
        if (maximized) activate?.(MAIN_SIDE_TAB);
        fillComposer(selectionFill(quote));
      },
      askInSideChat: (quote) => {
        addSideChatQuote(scope, quote);
        openSideChat?.();
      },
    }),
    [maximized, activate, fillComposer, scope, openSideChat],
  );
}
