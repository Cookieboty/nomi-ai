/**
 * Mascot window size (pure; shared by WindowManager, config migration and tests).
 *
 * The character is drawn in a box of BASE·scale (BASE = the old 420×450 window that the
 * character used to fill). Around it the window keeps a small transparent margin for the
 * toolbar slot (sides) and the speech bubble (above the head). Transparent pixels are
 * click-through (per-pixel hit test), so the margin never blocks the desktop.
 *
 * Keep MASCOT_PAD in sync with packages/renderer/src/mascot/spriteLayout.ts (tested there).
 */
export const MASCOT_BASE = { width: 420, height: 450 } as const;
export const MASCOT_PAD = { x: 60, top: 130 } as const;
/** default = half of the previous on-screen size */
export const DEFAULT_MASCOT_SCALE = 0.5;
export const MIN_MASCOT_SCALE = 0.3;
/** upper bound (hard); the effective cap is also limited by the display, see maxScaleForArea */
export const MAX_MASCOT_SCALE = 1.5;
/** one zoom-in / zoom-out click (menu / shortcut) */
export const MASCOT_SCALE_STEP = 0.1;

export function clampMascotScale(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_MASCOT_SCALE;
  return Math.min(MAX_MASCOT_SCALE, Math.max(MIN_MASCOT_SCALE, n));
}

/** scale stored with 2 decimals (stable config values, no float noise) */
export const roundMascotScale = (v: number): number => Math.round(v * 100) / 100;

export interface AreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Largest scale that still fits a display work area: the whole window (character + bubble slot)
 * must fit vertically and the character may take at most half of the width. On a 1366×768 laptop
 * this is ≈1.3, on 1080p and above the hard cap (1.5) applies.
 */
export function maxScaleForArea(
  area: Pick<AreaRect, 'width' | 'height'> | null | undefined,
): number {
  if (!area || !(area.width > 0) || !(area.height > 0)) return MAX_MASCOT_SCALE;
  const byHeight = (area.height - MASCOT_PAD.top) / MASCOT_BASE.height;
  const byWidth = (area.width * 0.5) / MASCOT_BASE.width;
  const cap = Math.floor(Math.min(byHeight, byWidth) * 100) / 100;
  return Math.min(MAX_MASCOT_SCALE, Math.max(MIN_MASCOT_SCALE, cap));
}

/** clamp to [MIN, min(MAX, display cap)] and round */
export function fitMascotScale(v: unknown, cap: number = MAX_MASCOT_SCALE): number {
  const hi = Math.min(MAX_MASCOT_SCALE, Math.max(MIN_MASCOT_SCALE, cap));
  return roundMascotScale(Math.min(hi, clampMascotScale(v)));
}

/** zoom step for the menu / keyboard: snaps to the 0.1 grid, so 0.5 → 0.6 → 0.7 … */
export function stepMascotScale(
  current: number,
  dir: 1 | -1,
  cap: number = MAX_MASCOT_SCALE,
): number {
  const k = clampMascotScale(current) / MASCOT_SCALE_STEP;
  const grid = dir === 1 ? Math.floor(k + 1e-6) + 1 : Math.ceil(k - 1e-6) - 1;
  return fitMascotScale(grid * MASCOT_SCALE_STEP, cap);
}

/** Ctrl/⌘ + wheel: smooth exponential zoom (deltaY < 0 = away from the user = bigger) */
export function wheelMascotScale(
  current: number,
  deltaY: number,
  deltaMode = 0,
  cap: number = MAX_MASCOT_SCALE,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return fitMascotScale(current, cap);
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY;
  const d = Math.max(-300, Math.min(300, px));
  return fitMascotScale(clampMascotScale(current) * Math.exp(-d * 0.002), cap);
}

export function mascotWindowSize(scale: number): { width: number; height: number } {
  const s = clampMascotScale(scale);
  return {
    width: Math.round(MASCOT_BASE.width * s + 2 * MASCOT_PAD.x),
    height: Math.round(MASCOT_BASE.height * s + MASCOT_PAD.top),
  };
}

/**
 * One-time migration for configs written before `mascotScale` existed: those users were on the
 * old full-size default, so they move to the new half-size default. The saved window position
 * (top-left of the old 420×450 window) is shifted so the character keeps its bottom-centre
 * anchor on screen instead of jumping up-left.
 */
export function migrateMascotSize(loaded: Record<string, unknown> | null | undefined): {
  mascotScale: number;
  windowPosition?: { x: number; y: number };
  migrated: boolean;
} {
  if (loaded && typeof loaded.mascotScale === 'number') {
    return { mascotScale: clampMascotScale(loaded.mascotScale), migrated: false };
  }
  const pos = loaded?.windowPosition as { x?: unknown; y?: unknown } | undefined;
  const next = mascotWindowSize(DEFAULT_MASCOT_SCALE);
  if (pos && typeof pos.x === 'number' && typeof pos.y === 'number' && (pos.x > 0 || pos.y > 0)) {
    return {
      mascotScale: DEFAULT_MASCOT_SCALE,
      windowPosition: {
        x: Math.round(pos.x + (MASCOT_BASE.width - next.width) / 2),
        y: Math.round(pos.y + (MASCOT_BASE.height - next.height)),
      },
      migrated: true,
    };
  }
  return { mascotScale: DEFAULT_MASCOT_SCALE, migrated: !!loaded };
}

export interface MascotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** the character's bounding box in window pixels (reported by the renderer, same as the physics box) */
export interface MascotBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * New window bounds after a scale change, keeping the feet-centre anchor fixed on screen.
 *
 * The character region of the window is [PAD.x, width-PAD.x] × [PAD.top, height] and it scales
 * linearly with `scale`, so a point p inside the window (window pixels) moves to
 * PAD + (p - PAD)·ratio. The anchor is the foot centre of `box` (its bottom-centre); without a
 * box the bottom-centre of the window is used.
 *
 * After anchoring, the result is clamped to the visible work area of the display holding the
 * anchor: vertically the whole window (head room for the speech bubble, feet above the dock),
 * horizontally the visible character (its box, or the whole character region when unknown) —
 * the transparent toolbar margin may hang off-screen, like it does while dragging, so parking the
 * mascot at a screen edge and zooming does not make her jump.
 */
export function resizeMascotBounds(input: {
  bounds: MascotBounds;
  fromScale: number;
  toScale: number;
  box?: MascotBox | null;
  workAreas?: AreaRect[];
}): MascotBounds {
  const { bounds } = input;
  const next = mascotWindowSize(input.toScale);
  const from = clampMascotScale(input.fromScale);
  const to = clampMascotScale(input.toScale);
  const ratio = to / from;
  const mapX = (v: number) => MASCOT_PAD.x + (v - MASCOT_PAD.x) * ratio;
  const mapY = (v: number) => MASCOT_PAD.top + (v - MASCOT_PAD.top) * ratio;
  const box = input.box;
  const okBox =
    !!box && [box.left, box.right, box.top, box.bottom].every((v) => Number.isFinite(v));
  const fx = okBox ? (box!.left + box!.right) / 2 : bounds.width / 2;
  const fy = okBox ? box!.bottom : bounds.height;
  let x = Math.round(bounds.x + fx - mapX(fx));
  let y = Math.round(bounds.y + fy - mapY(fy));

  const areas = input.workAreas ?? [];
  if (areas.length) {
    const ax = bounds.x + fx;
    const inside = areas.filter((a) => ax >= a.x && ax < a.x + a.width);
    const dist = (a: AreaRect) => (ax < a.x ? a.x - ax : ax - (a.x + a.width));
    const area = (inside.length ? inside : areas).reduce((a, b) => (dist(b) < dist(a) ? b : a));
    // visible horizontal extent of the character in the NEW window
    const visLeft = okBox ? mapX(box!.left) : MASCOT_PAD.x;
    const visRight = okBox ? mapX(box!.right) : next.width - MASCOT_PAD.x;
    const lo = area.x - visLeft;
    const hi = area.x + area.width - visRight;
    x = hi >= lo ? Math.min(hi, Math.max(lo, x)) : lo;
    const yHi = area.y + area.height - next.height;
    y = yHi >= area.y ? Math.min(yHi, Math.max(area.y, y)) : area.y;
  }
  return { x, y, width: next.width, height: next.height };
}
