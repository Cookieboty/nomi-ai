/**
 * 看板娘布局共享状态：角色包围盒（窗口坐标）+ 光标位置。
 * 由 InteractionLite 写入，宿主的工具栏、气泡等 UI 读取以避让角色、实现“靠近才显示”；
 * 工具栏槽位（gutter）由宿主写入，气泡读取。
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
