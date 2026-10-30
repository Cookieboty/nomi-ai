/**
 * 折叠态没有行内输入框：先展开侧栏再进入重命名（#163）。
 * 展开后行会挂载 inline editor，调用方再 setRenamingId。
 */
export function beginSidebarRename(
  id: string,
  collapsed: boolean,
  onToggle: () => void,
  setRenamingId: (id: string | null) => void,
): void {
  if (collapsed) onToggle();
  setRenamingId(id);
}
