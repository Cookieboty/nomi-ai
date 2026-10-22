import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONFIRM_MIN_W, intersects, placeConfirmBubble } from '../../src/mascot/bubblePlacement';

const box = (left: number, top: number, w: number, h: number) => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});
const rect = (p: { x: number; y: number; width: number; height: number }) =>
  box(p.x, p.y, p.width, p.height);

// 与 pnpm dev 截图一致：420×460 窗口，工具栏槽位在右侧 285..337
const view = { width: 420, height: 460 };
const gutter = box(285, 6, 52, 312);
const head = box(178, 196, 64, 64);
const measure = () => 96;

describe('placeConfirmBubble', () => {
  it('never overlaps the toolbar gutter or the face, and keeps buttons wide enough', () => {
    const p = placeConfirmBubble({ head, gutter, view, measure });
    expect(intersects(rect(p), gutter)).toBe(false);
    expect(intersects(rect(p), head)).toBe(false);
    expect(p.width).toBeGreaterThanOrEqual(CONFIRM_MIN_W);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual(view.width);
  });

  it('flips to the other side near the left screen edge', () => {
    // 看板娘贴在屏幕左边缘，工具栏在左：左侧不可用 → 必须放到右边 / 上下且仍不压工具栏
    const g = box(6, 6, 52, 312);
    const h = box(100, 150, 64, 64);
    const p = placeConfirmBubble({
      head: h,
      gutter: g,
      view: { width: 420, height: 300 },
      measure,
      screen: { winX: 0, availLeft: 0, availWidth: 1920 },
    });
    expect(intersects(rect(p), g)).toBe(false);
    expect(intersects(rect(p), h)).toBe(false);
  });

  it('respects the screen work area near the right edge', () => {
    const p = placeConfirmBubble({
      head: box(150, 120, 64, 64),
      gutter: null,
      view: { width: 420, height: 460 },
      measure,
      screen: { winX: 1700, availLeft: 0, availWidth: 1920 },
    });
    expect(1700 + p.x + p.width).toBeLessThanOrEqual(1920);
  });
});

// 摆放算的是 border-box 尺寸：气泡必须按 border-box 渲染、按摆放高度封顶，否则会越出窗口裁掉按钮（#80）
describe('DesktopConfirm bubble honours the placement box', () => {
  const dir = resolve(__dirname, '../../src/components/Mascot');
  const css = readFileSync(resolve(dir, 'DesktopConfirm.module.css'), 'utf8');
  const tsx = readFileSync(resolve(dir, 'DesktopConfirm.tsx'), 'utf8');

  it('uses border-box and lets only the text scroll', () => {
    const bubble = /\.bubble \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(bubble).toMatch(/box-sizing:\s*border-box/);
    const text = /\.text \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(text).toMatch(/overflow-y:\s*auto/);
  });

  it('caps the height at the placement height and measures without that cap', () => {
    expect(tsx).toMatch(/maxHeight: place\.height/);
    expect(tsx).not.toMatch(/minHeight: place\.height/);
    expect(tsx).toMatch(/el\.style\.maxHeight = 'none'/);
  });
});
