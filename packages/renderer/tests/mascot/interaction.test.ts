import { describe, expect, it, vi } from 'vitest';

import {
  ClickClassifier,
  PatDetector,
  reactionFor,
  REACTIONS,
} from '@/mascot/interaction/gestures';

describe('gestures', () => {
  it('detects a head pat from back-and-forth motion', () => {
    const p = new PatDetector(10, 1200, 3);
    const xs = [0, 15, 30, 15, 0, 15, 30, 15, 0];
    const hits = xs.map((x, i) => p.feed(x, i * 80));
    expect(hits.some(Boolean)).toBe(true);
  });

  it('ignores slow / tiny wiggles', () => {
    const p = new PatDetector(10, 1200, 3);
    const xs = [0, 3, 0, 3, 0, 3, 0, 3, 0];
    expect(xs.map((x, i) => p.feed(x, i * 80)).some(Boolean)).toBe(false);
    const q = new PatDetector(10, 1200, 3);
    expect([0, 20, 0, 20, 0].map((x, i) => q.feed(x, i * 2000)).some(Boolean)).toBe(false);
  });

  it('classifies single vs double clicks', () => {
    vi.useFakeTimers();
    const got: string[] = [];
    const c = new ClickClassifier((r, k) => got.push(`${k}:${r}`), 260);
    c.click('face');
    vi.advanceTimersByTime(300);
    c.click('head');
    vi.advanceTimersByTime(100);
    c.click('head');
    vi.advanceTimersByTime(300);
    expect(got).toEqual(['click:face', 'double:head']);
    vi.useRealTimers();
  });

  it('every region has a click reaction with a line; skirt protests', () => {
    for (const r of ['head', 'face', 'body', 'hands', 'skirt', 'legs'] as const) {
      const re = reactionFor('click', r);
      expect(re?.lines.length).toBeGreaterThan(0);
    }
    expect(reactionFor('click', 'skirt')?.expression).toBe('angry');
    expect(reactionFor('hover', 'skirt')?.expression).toBe('angry');
    expect(reactionFor('double', 'face')).toBe(REACTIONS.double?.any);
    expect(reactionFor('pat', 'head')?.expression).toBe('happy');
  });
});

describe('shape (Linux click-through)', () => {
  it('turns opaque pixels into padded scanline rects in window coords', async () => {
    const { alphaSpans, rectsKey } = await import('@/mascot/interaction/shape');
    const w = 32;
    const h = 16;
    const px = new Uint8Array(w * h * 4);
    // 不透明块：x 8..15，屏幕 y 0..7（GL 行序自下而上 → 行 8..15）
    for (let y = 0; y < 8; y += 1)
      for (let x = 8; x < 16; x += 1) px[((h - 1 - y) * w + x) * 4 + 3] = 255;
    const rects = alphaSpans(px, w, h, { band: 8, pad: 2, scale: 0.5, offsetX: 100, offsetY: 10 });
    expect(rects).toEqual([{ x: 100 + 4 - 2, y: 10 - 2, width: 4 + 4, height: 4 + 4 }]);
    expect(rectsKey(rects)).toBe('102,8,8,8');
    expect(alphaSpans(new Uint8Array(w * h * 4), w, h)).toEqual([]);
  });

  it('bridges small gaps but splits far-apart islands', async () => {
    const { alphaSpans } = await import('@/mascot/interaction/shape');
    const w = 64;
    const h = 8;
    const px = new Uint8Array(w * h * 4);
    for (const x of [2, 3, 6, 7, 40, 41])
      for (let y = 0; y < h; y += 1) px[(y * w + x) * 4 + 3] = 200;
    const rects = alphaSpans(px, w, h, { band: 8, pad: 0, gap: 4 });
    expect(rects.map((r) => [r.x, r.width])).toEqual([
      [2, 6],
      [40, 2],
    ]);
  });
});
