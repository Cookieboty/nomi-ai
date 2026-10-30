/**
 * 桌面角色布局共享状态：角色包围盒（窗口坐标）+ 光标位置。
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

const same = (a: Box | null, b: Box | null, eps = 0) =>
  !!a &&
  !!b &&
  Math.abs(a.left - b.left) <= eps &&
  Math.abs(a.right - b.right) <= eps &&
  Math.abs(a.top - b.top) <= eps &&
  Math.abs(a.bottom - b.bottom) <= eps;

export interface LayoutStore {
  get(): LayoutSnapshot;
  setBox(box: Box): void;
  /** 头部矩形：变化 < 3px 不广播（待机动画的微动） */
  setHead(head: Box | null): void;
  setCharBox(charBox: Box | null): void;
  setGutter(gutter: Box | null): void;
  setCursor(c: { x: number; y: number; inside: boolean }): void;
  /** 布局变化（box / head / charBox / gutter）；光标移动不通知（宿主推光标约 30 Hz，订阅方多是要量 DOM 的） */
  subscribe(l: Listener): () => void;
  /** 光标或布局任一变化都通知（“靠近才显示”这类要看光标的订阅方） */
  subscribeCursor(l: Listener): () => void;
}

/** 每个运行时一份（runtime.ts）；页面主运行时的就是 `layoutStore` */
export function createLayoutStore(): LayoutStore {
  let snap: LayoutSnapshot = { box: null, cursor: null, head: null, gutter: null, charBox: null };
  const listeners = new Set<Listener>();
  const cursorListeners = new Set<Listener>();
  const set = (next: LayoutSnapshot, layout = true) => {
    snap = next;
    if (layout) listeners.forEach((l) => l(snap));
    cursorListeners.forEach((l) => l(snap));
  };
  return {
    get: () => snap,
    setBox(box) {
      const b = snap.box;
      if (
        b &&
        b.left === box.left &&
        b.right === box.right &&
        b.top === box.top &&
        b.bottom === box.bottom
      )
        return;
      set({ ...snap, box });
    },
    setHead(head) {
      if (head === snap.head || same(head, snap.head, 3)) return;
      set({ ...snap, head });
    },
    setCharBox(charBox) {
      if (charBox === snap.charBox || same(charBox, snap.charBox, 3)) return;
      set({ ...snap, charBox });
    },
    setGutter(gutter) {
      if (gutter === snap.gutter || same(gutter, snap.gutter)) return;
      set({ ...snap, gutter });
    },
    setCursor(c) {
      const p = snap.cursor;
      if (p && p.x === c.x && p.y === c.y && p.inside === c.inside) return;
      set({ ...snap, cursor: c }, false);
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    subscribeCursor(l) {
      cursorListeners.add(l);
      return () => cursorListeners.delete(l);
    },
  };
}

/** 页面主运行时（`defaultAvatarRuntime`）的布局 */
export const layoutStore: LayoutStore = createLayoutStore();
