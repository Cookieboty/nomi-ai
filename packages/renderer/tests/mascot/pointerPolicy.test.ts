import { describe, expect, it } from 'vitest';

import {
  DragGate,
  HitHysteresis,
  hitRadius,
  inPaddedRects,
} from '@/mascot/interaction/pointerPolicy';

describe('DragGate', () => {
  it('hover (no button) never starts a drag', () => {
    const g = new DragGate();
    expect(g.move(100, 100, 0, 0)).toBeNull();
    expect(g.isDragging).toBe(false);
  });

  it('small movement is a click, > 6px starts a drag', () => {
    const g = new DragGate();
    g.press(0, 0, 0);
    expect(g.move(4, 3, 20, 1)).toBeNull(); // 5px
    expect(g.release()).toBe('click');
    g.press(0, 0, 0);
    expect(g.move(7, 0, 20, 1)).toBe('start');
    expect(g.release()).toBe('drop');
  });

  it('holding ≥150ms lowers the threshold', () => {
    const g = new DragGate();
    g.press(0, 0, 0);
    expect(g.move(4, 0, 100, 1)).toBeNull();
    expect(g.move(4, 0, 160, 1)).toBe('start');
  });

  it('a lost pointerup (buttons=0 on move) ends the press without dragging later', () => {
    const g = new DragGate();
    g.press(0, 0, 0);
    expect(g.move(2, 0, 10, 0)).toBeNull();
    expect(g.isDown).toBe(false);
    expect(g.move(50, 50, 200, 0)).toBeNull();
    expect(g.isDragging).toBe(false);
  });

  it('lost pointerup during a drag reports cancel', () => {
    const g = new DragGate();
    g.press(0, 0, 0);
    g.move(20, 0, 10, 1);
    expect(g.move(30, 0, 20, 0)).toBe('cancel');
    expect(g.isDragging).toBe(false);
  });
});

describe('HitHysteresis', () => {
  it('enters immediately and leaves only after 120ms of continuous miss', () => {
    const h = new HitHysteresis(120);
    expect(h.feed(true, 0)).toBe(true);
    expect(h.feed(false, 50)).toBe(true);
    expect(h.feed(true, 100)).toBe(true); // 抖动回来：重置
    expect(h.feed(false, 150)).toBe(true);
    expect(h.feed(false, 260)).toBe(true);
    expect(h.feed(false, 271)).toBe(false);
  });

  it('reports `leaving` while the leave debounce is pending, so a stopped cursor still settles', () => {
    const h = new HitHysteresis(120);
    expect(h.leaving).toBe(false);
    h.feed(true, 0);
    expect(h.leaving).toBe(false);
    h.feed(false, 10);
    expect(h.leaving).toBe(true);
    h.feed(false, 140);
    expect(h.value).toBe(false);
    expect(h.leaving).toBe(false);
    h.feed(true, 150);
    h.feed(false, 160);
    h.feed(true, 170); // jitter back: no longer leaving
    expect(h.leaving).toBe(false);
  });

  it('dilates more while hit (leave margin > enter margin)', () => {
    expect(hitRadius(true)).toBeGreaterThan(hitRadius(false));
  });

  it('padded UI rects', () => {
    const r = [{ left: 100, top: 100, right: 140, bottom: 300 }];
    expect(inPaddedRects(90, 150, r, 16)).toBe(true);
    expect(inPaddedRects(80, 150, r, 16)).toBe(false);
  });
});
