/** 添加文件夹菜单：贴着触发按钮，空间不够就翻到上面，左右不超出窗口。 */

const EDGE = 8;
const GAP = 4;
const MENU_WIDTH = 420;
/** 下面至少要有这么高才向下展开，否则翻到按钮上方 */
const PREFER_BELOW = 200;

export interface MenuBox {
  position: 'fixed';
  left: number;
  width: number;
  maxHeight: number;
  zIndex: number;
  top?: number;
  bottom?: number;
}

export function placeAddFolderMenu(
  anchor: Pick<DOMRect, 'top' | 'bottom' | 'left'>,
  viewport: { width: number; height: number },
): MenuBox {
  const width = Math.min(MENU_WIDTH, Math.max(160, viewport.width - EDGE * 2));
  let left = anchor.left;
  if (left + width > viewport.width - EDGE) left = viewport.width - EDGE - width;
  if (left < EDGE) left = EDGE;
  const spaceBelow = viewport.height - anchor.bottom - GAP - EDGE;
  const spaceAbove = anchor.top - GAP - EDGE;
  const below = spaceBelow >= PREFER_BELOW || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(72, Math.floor(below ? spaceBelow : spaceAbove));
  const box: MenuBox = {
    position: 'fixed',
    left,
    width,
    maxHeight,
    // 挂到 body 上，要盖过对话框（--cd-z-modal: 100000）
    zIndex: 100010,
  };
  if (below) box.top = anchor.bottom + GAP;
  else box.bottom = viewport.height - anchor.top + GAP;
  return box;
}
