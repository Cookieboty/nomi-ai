/**
 * 看板娘布局共享状态：角色包围盒（窗口坐标）+ 光标位置。
 * 由 InteractionLite 写入，工具栏等 UI 读取以避让角色、实现“靠近才显示”。
 */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export interface LayoutSnapshot {
  box: Box | null;
  cursor: { x: number; y: number; inside: boolean } | null;
  /** 头部（含脸）在窗口里的矩形，随动画 / 相机实时更新 */
  head: Box | null;
  /** 工具栏占用的槽位（无论当前是否显示） */
  gutter: Box | null;
  /** 整个角色框（角色包 hitboxes / bubbleAnchor 的比例基准），与 head 同频更新 */
  charBox: Box | null;
}

type Listener = (s: LayoutSnapshot) => void;
let snap: LayoutSnapshot = { box: null, cursor: null, head: null, gutter: null, charBox: null };
const same = (a: Box | null, b: Box | null, eps = 0) =>
  !!a &&
  !!b &&
  Math.abs(a.left - b.left) <= eps &&
  Math.abs(a.right - b.right) <= eps &&
  Math.abs(a.top - b.top) <= eps &&
  Math.abs(a.bottom - b.bottom) <= eps;
const listeners = new Set<Listener>();

export const layoutStore = {
  get: (): LayoutSnapshot => snap,
  setBox(box: Box) {
    const b = snap.box;
    if (
      b &&
      b.left === box.left &&
      b.right === box.right &&
      b.top === box.top &&
      b.bottom === box.bottom
    )
      return;
    snap = { ...snap, box };
    listeners.forEach((l) => l(snap));
  },
  /** 头部矩形：变化 < 3px 不广播（待机动画的微动） */
  setHead(head: Box | null) {
    if (head === snap.head || same(head, snap.head, 3)) return;
    snap = { ...snap, head };
    listeners.forEach((l) => l(snap));
  },
  setCharBox(charBox: Box | null) {
    if (charBox === snap.charBox || same(charBox, snap.charBox, 3)) return;
    snap = { ...snap, charBox };
    listeners.forEach((l) => l(snap));
  },
  setGutter(gutter: Box | null) {
    if (gutter === snap.gutter || same(gutter, snap.gutter)) return;
    snap = { ...snap, gutter };
    listeners.forEach((l) => l(snap));
  },
  setCursor(c: { x: number; y: number; inside: boolean }) {
    snap = { ...snap, cursor: c };
    listeners.forEach((l) => l(snap));
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export interface GutterInput {
  box: Box | null;
  /** 工具栏尺寸 */
  bar: { width: number; height: number };
  view: { width: number; height: number };
  /** 窗口在屏幕上的位置与工作区（用于贴屏幕边缘时翻转） */
  screen?: { winX: number; availLeft: number; availWidth: number };
  gap?: number;
  margin?: number;
}
export interface GutterPlacement {
  side: 'left' | 'right';
  x: number;
  y: number;
  /** 工具栏是否与角色包围盒重叠（空间实在不够时才会发生） */
  overlaps: boolean;
}

/**
 * 纯函数：把工具栏放进角色旁边的“预留槽位”，不覆盖角色包围盒。
 * 优先右侧；右侧放不下或窗口右缘贴近 / 超出屏幕工作区时翻到左侧。
 */
export function placeGutter(i: GutterInput): GutterPlacement {
  const gap = i.gap ?? 12;
  const m = i.margin ?? 6;
  const { width: bw, height: bh } = i.bar;
  const { width: vw, height: vh } = i.view;
  const box = i.box ?? {
    left: vw * 0.25,
    right: vw * 0.65,
    top: vh * 0.1,
    bottom: vh * 0.95,
  };
  const rightX = box.right + gap;
  const leftX = box.left - gap - bw;
  const fitsRight = rightX + bw <= vw - m;
  const fitsLeft = leftX >= m;
  let offRight = false;
  let offLeft = false;
  if (i.screen) {
    const screenRight = i.screen.availLeft + i.screen.availWidth;
    offRight = i.screen.winX + rightX + bw > screenRight - m;
    offLeft = i.screen.winX + leftX < i.screen.availLeft + m;
  }
  let side: 'left' | 'right';
  if (fitsRight && !offRight) side = 'right';
  else if (fitsLeft && !offLeft) side = 'left';
  else if (fitsRight || fitsLeft) side = fitsRight ? 'right' : 'left';
  else side = vw - box.right >= box.left ? 'right' : 'left';
  const rawX = side === 'right' ? rightX : leftX;
  const x = Math.round(Math.max(m, Math.min(vw - bw - m, rawX)));
  // 垂直：对齐到上半身（包围盒 30% 处），并限制在窗口内
  const cy = box.top + (box.bottom - box.top) * 0.3;
  const y = Math.round(Math.max(m, Math.min(vh - bh - m, cy - bh / 2)));
  const overlaps = x < box.right && x + bw > box.left;
  return { side, x, y, overlaps };
}
