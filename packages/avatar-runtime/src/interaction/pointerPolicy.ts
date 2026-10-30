/**
 * 指针策略（纯逻辑，便于单测）：
 * - DragGate：按下后只有「移动 > moveThreshold」或「按住 ≥ holdMs 且移动 > holdMove」才算拖拽；
 *   没按键（buttons=0）时绝不进入拖拽 —— macOS 上点击穿透切换可能吞掉 pointerup，
 *   旧实现会在随后的悬停移动里误判为拖拽（她被“拎起来”）。
 * - HitHysteresis：命中立即生效；连续未命中超过 leaveMs 才释放（点击穿透不在轮廓边缘闪烁）。
 */

export interface DragGateOptions {
  moveThreshold: number;
  holdMs: number;
  holdMove: number;
}

export const DEFAULT_DRAG_GATE: DragGateOptions = { moveThreshold: 6, holdMs: 150, holdMove: 3 };

export class DragGate {
  private down: { x: number; y: number; t: number } | null = null;
  private dragging = false;

  constructor(private readonly o: DragGateOptions = DEFAULT_DRAG_GATE) {}

  get isDown(): boolean {
    return this.down !== null;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  press(x: number, y: number, t: number): void {
    this.down = { x, y, t };
    this.dragging = false;
  }

  /**
   * 指针移动。返回 'start' 表示此刻开始拖拽；'cancel' 表示按键已松开但没收到 up（视为结束）。
   * @param buttons PointerEvent.buttons（左键位 = 1）
   */
  move(x: number, y: number, t: number, buttons: number): 'start' | 'cancel' | null {
    if (!this.down) return null;
    if ((buttons & 1) === 0) {
      this.down = null;
      const was = this.dragging;
      this.dragging = false;
      return was ? 'cancel' : null;
    }
    if (this.dragging) return null;
    const d = Math.hypot(x - this.down.x, y - this.down.y);
    const held = t - this.down.t;
    if (d > this.o.moveThreshold || (held >= this.o.holdMs && d > this.o.holdMove)) {
      this.dragging = true;
      return 'start';
    }
    return null;
  }

  /** 松开：返回 'click'（没拖过）或 'drop'（拖拽结束） */
  release(): 'click' | 'drop' | null {
    if (!this.down) return null;
    const r = this.dragging ? 'drop' : 'click';
    this.down = null;
    this.dragging = false;
    return r;
  }

  cancel(): boolean {
    const was = this.dragging;
    this.down = null;
    this.dragging = false;
    return was;
  }
}

export class HitHysteresis {
  private state = false;
  private missSince: number | null = null;

  constructor(private readonly leaveMs = 120) {}

  get value(): boolean {
    return this.state;
  }

  /** 已经没命中、正在等 leaveMs 过期：此时即使没有新的光标事件也要继续喂 */
  get leaving(): boolean {
    return this.missSince !== null;
  }

  /** 输入原始命中，返回去抖后的命中 */
  feed(raw: boolean, t: number): boolean {
    if (raw) {
      this.state = true;
      this.missSince = null;
    } else if (this.state) {
      if (this.missSince === null) this.missSince = t;
      if (t - this.missSince >= this.leaveMs) {
        this.state = false;
        this.missSince = null;
      }
    }
    return this.state;
  }
}

/** 进入 / 离开用不同的膨胀半径（像素）：已命中时轮廓“更胖”，避免边缘抖动 */
export function hitRadius(currentlyHit: boolean): number {
  return currentlyHit ? 10 : 4;
}

export interface UiRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 点在任一 UI 矩形外扩 pad 像素的范围内 */
export function inPaddedRects(x: number, y: number, rects: UiRect[], pad: number): boolean {
  return rects.some(
    (r) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad,
  );
}
