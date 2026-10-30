import { describe, expect, it } from 'vitest';

import { placeGutter } from '../../src/components/ToolBar/gutter';

const view = { width: 420, height: 450 };
const bar = { width: 46, height: 230 };
const box = { left: 110, right: 250, top: 40, bottom: 430 };

describe('toolbar gutter placement', () => {
  it('sits right of the character without overlapping her box', () => {
    const p = placeGutter({ box, bar, view });
    expect(p.side).toBe('right');
    expect(p.x).toBeGreaterThanOrEqual(box.right);
    expect(p.overlaps).toBe(false);
    expect(p.y).toBeGreaterThanOrEqual(6);
    expect(p.y + bar.height).toBeLessThanOrEqual(view.height - 6);
  });
  it('flips left when the window hangs past the right screen edge', () => {
    const p = placeGutter({
      box,
      bar,
      view,
      screen: { winX: 1700, availLeft: 0, availWidth: 1920 },
    });
    expect(p.side).toBe('left');
    expect(p.x + bar.width).toBeLessThanOrEqual(box.left);
    expect(p.overlaps).toBe(false);
  });
  it('flips left when there is no room on the right inside the window', () => {
    const p = placeGutter({ box: { ...box, left: 170, right: 380 }, bar, view });
    expect(p.side).toBe('left');
    expect(p.overlaps).toBe(false);
  });
  it('stays right near the left screen edge', () => {
    const p = placeGutter({
      box,
      bar,
      view,
      screen: { winX: -100, availLeft: 0, availWidth: 1920 },
    });
    expect(p.side).toBe('right');
  });
  it('always stays inside the window', () => {
    const p = placeGutter({ box: { left: 0, right: 420, top: 0, bottom: 450 }, bar, view });
    expect(p.x).toBeGreaterThanOrEqual(6);
    expect(p.x + bar.width).toBeLessThanOrEqual(view.width - 6);
  });
});
