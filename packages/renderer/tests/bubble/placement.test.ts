import type { Box } from '@nomi-ai/avatar-runtime';
import { describe, expect, it } from 'vitest';

import { bubbleScale, intersects, placeBubble, shortReply } from '../../src/mascot/bubblePlacement';

const view = { width: 420, height: 450 };
// 默认模型的大致头部矩形（窗口顶部附近）
const head: Box = { left: 135, right: 215, top: 30, bottom: 120 };
const gutterRight: Box = { left: 255, right: 301, top: 40, bottom: 270 };
const measure = (lines: number) => (w: number) =>
  Math.min(200, 16 + lines * 22 + (w < 160 ? 22 : 0));
const rect = (p: { x: number; y: number; width: number; height: number }): Box => ({
  left: p.x,
  top: p.y,
  right: p.x + p.width,
  bottom: p.y + p.height,
});

describe('bubble placement', () => {
  it('goes above the head when there is room', () => {
    const p = placeBubble({ head: { ...head, top: 160, bottom: 240 }, view, measure: measure(2) });
    expect(p.candidate).toBe('above');
    expect(p.tail).toBe('bottom');
    expect(rect(p).bottom).toBeLessThanOrEqual(160);
  });

  it('never covers the face; picks the side away from the toolbar gutter', () => {
    const p = placeBubble({ head, view, measure: measure(2), gutter: gutterRight });
    expect(intersects(rect(p), head)).toBe(false);
    expect(intersects(rect(p), gutterRight)).toBe(false);
    expect(p.candidate).toBe('left');
    expect(p.tail).toBe('right');
    // 尾巴指向头部中心的高度
    expect(p.y + p.tailOffset).toBeGreaterThanOrEqual(head.top);
    expect(p.y + p.tailOffset).toBeLessThanOrEqual(head.bottom);
  });

  it('flips to the right when the left side is off-screen', () => {
    const p = placeBubble({
      head,
      view,
      measure: measure(2),
      screen: { winX: -100, availLeft: 0, availWidth: 1920 },
    });
    expect(p.candidate).toBe('right');
    expect(intersects(rect(p), head)).toBe(false);
  });

  it('falls back below the head (still not on the face) when nothing else fits', () => {
    const big: Box = { left: 40, right: 380, top: 8, bottom: 150 };
    const p = placeBubble({ head: big, view, measure: measure(3), gutter: gutterRight });
    expect(p.candidate).toBe('below');
    expect(p.tail).toBe('top');
    expect(intersects(rect(p), big)).toBe(false);
  });

  it('stays inside the window and caps height (long text scrolls)', () => {
    for (let x = 0; x <= 340; x += 20) {
      const h: Box = { left: x, right: x + 80, top: 30, bottom: 120 };
      const p = placeBubble({ head: h, view, measure: measure(40) });
      expect(p.x).toBeGreaterThanOrEqual(6);
      expect(p.x + p.width).toBeLessThanOrEqual(view.width - 6);
      expect(p.y + p.height).toBeLessThanOrEqual(view.height - 6);
      expect(p.height).toBeLessThanOrEqual(200);
      expect(intersects(rect(p), h)).toBe(false);
    }
  });

  it('scales with head size', () => {
    expect(bubbleScale({ left: 0, right: 40, top: 0, bottom: 40 })).toBe(0.85);
    expect(bubbleScale({ left: 0, right: 80, top: 0, bottom: 80 })).toBe(1);
    expect(bubbleScale({ left: 0, right: 200, top: 0, bottom: 200 })).toBe(1.15);
  });
});

describe('shortReply', () => {
  it('keeps the first sentence(s) and marks truncation', () => {
    const r = shortReply(
      '你好！今天天气很好。我们可以去公园散步，也可以在家看书。还有很多别的选择，比如去博物馆、美术馆或者图书馆，看看最新的展览，顺便吃点好吃的东西，然后再回家休息。',
    );
    expect(r.text.startsWith('你好！')).toBe(true);
    expect(r.truncated).toBe(true);
    expect(Array.from(r.text).length).toBeLessThanOrEqual(90);
  });
  it('returns short replies untouched', () => {
    expect(shortReply('Sure, done.')).toEqual({ text: 'Sure, done.', truncated: false });
  });
  it('cuts a single overlong sentence with an ellipsis', () => {
    const r = shortReply('a'.repeat(300));
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith('…')).toBe(true);
    expect(Array.from(r.text)).toHaveLength(90);
  });
});
