import { useCallback, type RefObject } from 'react';

import { useShortcutEvent } from '../../services/shortcuts';

import { beginSidebarRename } from './sidebarRename';

/** 折叠时先展开再进入重命名（#163）；并绑定 renameTab 快捷键 */
export function useSidebarRename(
  collapsed: boolean,
  onToggle: () => void,
  highlightId: string | undefined,
  setRenamingId: (id: string | null) => void,
): (id: string) => void {
  const startRename = useCallback(
    (id: string) => beginSidebarRename(id, collapsed, onToggle, setRenamingId),
    [collapsed, onToggle, setRenamingId],
  );
  useShortcutEvent('renameTab', () => {
    if (highlightId) startRename(highlightId);
  });
  return startRename;
}

/** 打开侧栏搜索并聚焦输入框 */
export function useSidebarSearchShortcut(
  setSearchOpen: (open: boolean) => void,
  inputRef: RefObject<HTMLInputElement | null>,
): void {
  useShortcutEvent('searchChats', () => {
    setSearchOpen(true);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  });
}
