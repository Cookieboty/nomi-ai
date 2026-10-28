/**
 * Character box inside the mascot window (sprite renderer).
 * The window is the character box (half the old size by default) plus a transparent margin for
 * the toolbar slot (sides) and the speech bubble (above the head); see
 * packages/core/src/mascot/mascotSize.ts. Keep MASCOT_PAD in sync (unit-tested).
 */
export const MASCOT_PAD = { x: 60, top: 130 } as const;

export function characterBox(w: number, h: number): { x: number; y: number; w: number; h: number } {
  // tiny / unexpected windows (tests, browser preview): use the whole canvas
  if (w < MASCOT_PAD.x * 2 + 80 || h < MASCOT_PAD.top + 80) return { x: 0, y: 0, w, h };
  return { x: MASCOT_PAD.x, y: MASCOT_PAD.top, w: w - MASCOT_PAD.x * 2, h: h - MASCOT_PAD.top };
}
