import { describe, expect, it } from 'vitest';

import { bubbleAnchorBox, regionFromHitboxes } from '../src/spriteInteraction';

const hitboxes = {
  regions: {
    head: { top: 0.04, bottom: 0.28, left: 0.16, right: 0.84 },
    face: { top: 0.1, bottom: 0.32, left: 0.22, right: 0.78 },
    body: { top: 0.28, bottom: 0.6, left: 0.18, right: 0.82 },
    hand: { top: 0.45, bottom: 0.7, left: 0.05, right: 0.95 },
    hem: { top: 0.6, bottom: 1, left: 0.15, right: 0.85 },
  },
  bubbleAnchor: { x: 0.72, y: 0.18 },
};

const box = { left: 100, right: 200, top: 50, bottom: 250 }; // 100x200

describe('regionFromHitboxes', () => {
  it('maps hem / hand→hands and prefers face over head', () => {
    // center of face region
    const fx = 100 + 100 * 0.5;
    const fy = 50 + 200 * 0.2;
    expect(regionFromHitboxes(fx, fy, box, hitboxes)).toBe('face');
    // hem center
    const hx = 100 + 100 * 0.5;
    const hy = 50 + 200 * 0.8;
    expect(regionFromHitboxes(hx, hy, box, hitboxes)).toBe('hem');
    // hand side
    const handX = 100 + 100 * 0.08;
    const handY = 50 + 200 * 0.55;
    expect(regionFromHitboxes(handX, handY, box, hitboxes)).toBe('hands');
  });

  it('returns null outside box or with empty regions', () => {
    expect(regionFromHitboxes(10, 10, box, hitboxes)).toBeNull();
    expect(regionFromHitboxes(150, 100, box, { regions: {} })).toBeNull();
  });

  it('normalizes legacy skirt id via mapRegionId path (pack already normalized)', () => {
    const legacy = {
      regions: {
        skirt: { top: 0.6, bottom: 1, left: 0.15, right: 0.85 },
      },
    };
    const hx = 100 + 100 * 0.5;
    const hy = 50 + 200 * 0.8;
    expect(regionFromHitboxes(hx, hy, box, legacy as unknown as typeof hitboxes)).toBe('hem');
  });
});

describe('bubbleAnchorBox', () => {
  it('builds a small head-like box around bubbleAnchor', () => {
    const a = bubbleAnchorBox(box, hitboxes);
    expect(a).toBeTruthy();
    expect(a!.left).toBeLessThan(a!.right);
    expect(a!.top).toBeLessThan(a!.bottom);
    // anchor center roughly at 0.72 / 0.18 of box
    const cx = (a!.left + a!.right) / 2;
    const cy = (a!.top + a!.bottom) / 2;
    expect(cx).toBeCloseTo(100 + 100 * 0.72, 0);
    expect(cy).toBeCloseTo(50 + 200 * 0.18, 0);
  });

  it('returns null without anchor', () => {
    expect(bubbleAnchorBox(box, { regions: hitboxes.regions })).toBeNull();
    expect(bubbleAnchorBox(box, null)).toBeNull();
  });
});
