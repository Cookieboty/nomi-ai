/** 标题栏按钮弹出的菜单离对话卡片顶边的距离：与会话详情浮层一样（--cd-space-3），不紧贴顶边 */
export const TITLEBAR_MENU_GAP = 12;

/** 标题栏按钮下方菜单的 top：按钮下方 4px，且至少离对话卡片顶边 TITLEBAR_MENU_GAP */
export function titlebarMenuTop(btn: DOMRect): number {
  const card = document.querySelector('[data-testid="workspace-card"]')?.getBoundingClientRect();
  return Math.max(btn.bottom + 4, (card ? card.top : btn.bottom) + TITLEBAR_MENU_GAP);
}
