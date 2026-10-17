import {
  DEFAULT_MASCOT_SCALE,
  MASCOT_BASE,
  MASCOT_PAD,
  MAX_MASCOT_SCALE,
  MIN_MASCOT_SCALE,
  clampMascotScale,
  fitMascotScale,
  mascotWindowSize,
  maxScaleForArea,
  migrateMascotSize,
  resizeMascotBounds,
  stepMascotScale,
  wheelMascotScale,
} from '../../../src/mascot/mascotSize';

const FHD = { x: 0, y: 0, width: 1920, height: 1040 };

describe('mascot scale range', () => {
  it('allows 0.3–1.5 (default 0.5) and rejects junk', () => {
    expect([MIN_MASCOT_SCALE, DEFAULT_MASCOT_SCALE, MAX_MASCOT_SCALE]).toEqual([0.3, 0.5, 1.5]);
    expect(clampMascotScale(0.01)).toBe(0.3);
    expect(clampMascotScale(9)).toBe(1.5);
    expect(clampMascotScale(1.2)).toBe(1.2);
    expect(clampMascotScale('x')).toBe(0.5);
    expect(clampMascotScale(NaN)).toBe(0.5);
    expect(migrateMascotSize({ mascotScale: 9 }).mascotScale).toBe(1.5);
  });

  it('window = character box + fixed margins', () => {
    expect(mascotWindowSize(1.5)).toEqual({
      width: Math.round(MASCOT_BASE.width * 1.5 + 2 * MASCOT_PAD.x),
      height: Math.round(MASCOT_BASE.height * 1.5 + MASCOT_PAD.top),
    });
    expect(mascotWindowSize(0.3)).toEqual({ width: 246, height: 265 });
  });

  it('display cap: big screens get the hard cap, small ones shrink it, never below the minimum', () => {
    expect(maxScaleForArea(FHD)).toBe(1.5);
    expect(maxScaleForArea({ width: 3840, height: 2100 })).toBe(1.5);
    // 1366×768 laptop (work area ≈ 728 high): window must fit vertically
    const laptop = maxScaleForArea({ width: 1366, height: 728 });
    expect(laptop).toBeLessThan(1.5);
    expect(mascotWindowSize(laptop).height).toBeLessThanOrEqual(728);
    // tiny / odd areas
    expect(maxScaleForArea({ width: 400, height: 200 })).toBe(0.3);
    expect(maxScaleForArea(null)).toBe(1.5);
    expect(fitMascotScale(1.5, laptop)).toBe(laptop);
    expect(fitMascotScale(0.31234)).toBe(0.31);
  });

  it('steps snap to the 0.1 grid and respect the caps', () => {
    expect(stepMascotScale(0.5, 1)).toBe(0.6);
    expect(stepMascotScale(0.5, -1)).toBe(0.4);
    expect(stepMascotScale(0.53, 1)).toBe(0.6);
    expect(stepMascotScale(0.53, -1)).toBe(0.5);
    expect(stepMascotScale(0.3, -1)).toBe(0.3);
    expect(stepMascotScale(1.5, 1)).toBe(1.5);
    expect(stepMascotScale(1.2, 1, 1.25)).toBe(1.25);
    // walking up the whole range never skips a grid point (float noise safe)
    let v = 0.3;
    const seen: number[] = [v];
    for (let i = 0; i < 20; i += 1) {
      v = stepMascotScale(v, 1);
      seen.push(v);
    }
    expect(seen.slice(0, 13)).toEqual([
      0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5,
    ]);
  });

  it('wheel: up zooms in, down zooms out, smooth and clamped', () => {
    expect(wheelMascotScale(0.5, -100)).toBeGreaterThan(0.5);
    expect(wheelMascotScale(0.5, 100)).toBeLessThan(0.5);
    expect(wheelMascotScale(0.5, 0)).toBe(0.5);
    expect(wheelMascotScale(1.45, -10_000)).toBeLessThanOrEqual(1.5);
    expect(wheelMascotScale(0.31, 10_000)).toBeGreaterThanOrEqual(0.3);
    // line mode counts as 16px per line
    expect(wheelMascotScale(0.5, -3, 1)).toBe(wheelMascotScale(0.5, -48, 0));
    // one notch (100px) is a visible but modest step
    const notch = wheelMascotScale(0.5, -100);
    expect(notch / 0.5).toBeGreaterThan(1.1);
    expect(notch / 0.5).toBeLessThan(1.3);
    expect(wheelMascotScale(1, -100, 0, 1.05)).toBe(1.05);
  });
});

describe('resizeMascotBounds keeps the feet-centre anchor', () => {
  const winAt = (x: number, y: number, s: number) => ({ x, y, ...mascotWindowSize(s) });
  const feetOf = (b: { x: number; y: number; width: number; height: number }) => ({
    x: b.x + b.width / 2,
    y: b.y + b.height,
  });

  it('bottom-centre stays put for every step when there is room (no feet info)', () => {
    let b = winAt(800, 500, 0.5);
    const a0 = feetOf(b);
    for (const to of [0.6, 0.9, 1.5, 1.2, 0.7, 0.3, 0.5]) {
      const from = (b.width - 2 * MASCOT_PAD.x) / MASCOT_BASE.width;
      b = resizeMascotBounds({ bounds: b, fromScale: from, toScale: to, workAreas: [FHD] });
      expect(b.width).toBe(mascotWindowSize(to).width);
      expect(b.height).toBe(mascotWindowSize(to).height);
      const a = feetOf(b);
      expect(Math.abs(a.x - a0.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(a.y - a0.y)).toBeLessThanOrEqual(1);
    }
  });

  it('uses the reported character box when known (feet above the window bottom)', () => {
    const b = winAt(800, 300, 1);
    // feet 12px above the window bottom, slightly off-centre
    const box = {
      left: b.width / 2 - 70,
      right: b.width / 2 + 90,
      top: 150,
      bottom: b.height - 12,
    };
    const feet = { x: (box.left + box.right) / 2, y: box.bottom };
    const before = { x: b.x + feet.x, y: b.y + feet.y };
    const n = resizeMascotBounds({ bounds: b, fromScale: 1, toScale: 0.5, box, workAreas: [FHD] });
    const k = 0.5;
    const after = {
      x: n.x + MASCOT_PAD.x + (feet.x - MASCOT_PAD.x) * k,
      y: n.y + MASCOT_PAD.top + (feet.y - MASCOT_PAD.top) * k,
    };
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  });

  it('standing on the floor stays on the floor while growing', () => {
    const floor = FHD.y + FHD.height;
    const b = winAt(1000, floor - mascotWindowSize(0.5).height, 0.5);
    const n = resizeMascotBounds({ bounds: b, fromScale: 0.5, toScale: 1.5, workAreas: [FHD] });
    expect(n.y + n.height).toBe(floor);
    expect(n.y).toBeGreaterThanOrEqual(FHD.y);
  });

  it('clamps into the visible work area (top, bottom, left, right edges)', () => {
    // near the top: growing must not push the head / bubble room above the screen
    let n = resizeMascotBounds({
      bounds: winAt(900, 5, 0.5),
      fromScale: 0.5,
      toScale: 1.5,
      workAreas: [FHD],
    });
    expect(n.y).toBeGreaterThanOrEqual(0);
    // feet below the dock line: pulled back above it
    const low = winAt(900, FHD.height - 100, 0.5);
    n = resizeMascotBounds({ bounds: low, fromScale: 0.5, toScale: 1, workAreas: [FHD] });
    expect(n.y + n.height).toBeLessThanOrEqual(FHD.height);
    // right edge: character region stays on screen (toolbar margin may hang off)
    const right = winAt(FHD.width - mascotWindowSize(0.5).width, 400, 0.5);
    n = resizeMascotBounds({ bounds: right, fromScale: 0.5, toScale: 1.5, workAreas: [FHD] });
    expect(n.x + n.width - MASCOT_PAD.x).toBeLessThanOrEqual(FHD.width);
    // left edge
    n = resizeMascotBounds({
      bounds: winAt(-40, 400, 0.5),
      fromScale: 0.5,
      toScale: 1.5,
      workAreas: [FHD],
    });
    expect(n.x + MASCOT_PAD.x).toBeGreaterThanOrEqual(0);
  });

  it('parked at a screen edge: the visible character decides, not the transparent margin', () => {
    // character box is narrower than the character region (typical for the sprite)
    const w = mascotWindowSize(0.5);
    const box = { left: 100, right: 230, top: 150, bottom: 355 };
    // right edge: visible right side exactly at the screen edge
    const b = { x: FHD.width - box.right, y: 600, ...w };
    const n = resizeMascotBounds({ bounds: b, fromScale: 0.5, toScale: 1, box, workAreas: [FHD] });
    const k = (v: number) => MASCOT_PAD.x + (v - MASCOT_PAD.x) * 2;
    expect(n.x + k(box.right)).toBeLessThanOrEqual(FHD.width);
    // the margin hangs off the screen (allowed) and the feet did not slide more than the clamp needs
    expect(n.x + k(box.right)).toBe(FHD.width);
    // a box that fits is never moved: anchor exact when there is room
    const mid = resizeMascotBounds({
      bounds: { x: 800, y: 500, ...w },
      fromScale: 0.5,
      toScale: 1,
      box,
      workAreas: [FHD],
    });
    expect(mid.x + k((box.left + box.right) / 2)).toBe(800 + (box.left + box.right) / 2);
  });

  it('multi-monitor: clamps to the display that holds the feet', () => {
    const second = { x: 1920, y: 0, width: 1280, height: 720 };
    const b = winAt(1920 + 1000, 700 - mascotWindowSize(0.5).height + 20, 0.5);
    const cap = maxScaleForArea(second);
    const n = resizeMascotBounds({
      bounds: b,
      fromScale: 0.5,
      toScale: cap,
      workAreas: [FHD, second],
    });
    expect(n.y + n.height).toBeLessThanOrEqual(second.y + second.height);
    expect(n.x + MASCOT_PAD.x).toBeGreaterThanOrEqual(second.x);
  });
});
