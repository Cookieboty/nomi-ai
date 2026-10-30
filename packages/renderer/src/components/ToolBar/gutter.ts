/** 工具栏槽位：放在角色包围盒旁边，不覆盖角色（原在 mascot/layoutStore.ts）。 */
import type { Box } from '@nomi-ai/avatar-runtime';

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
