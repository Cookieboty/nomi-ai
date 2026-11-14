/**
 * 主窗口里「选中文字」的两个动作（SelectionActionsContext）：
 * - 添加到对话：引用加到主会话输入框（文件选区用文件链接：路径 + 行号）；铺满且不在主会话时先切到主会话；
 * - 在侧边聊天中提问：当前标签是侧边聊天时加到它的输入栏上，否则新开一个侧边聊天带上选区
 *   （标签栏「+ → 新侧边聊天」总是新开）。
 */
import { useMemo } from 'react';

import { useChangesUi } from '../components/SessionWorkspace';
import type { SelectionActions } from '../contexts/SelectionActionsContext';
import { useSubagentPane } from '../contexts/SubagentPaneContext';
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
        openSideChat?.({ quote });
      },
    }),
    [maximized, activate, fillComposer, openSideChat],
  );
}
