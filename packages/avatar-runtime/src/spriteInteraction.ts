import type { BodyRegion } from './interaction/regions';
import type { Box } from './layoutStore';
import type { MascotBackend } from './MascotBackend';

export interface HitboxRegion {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 命中区（角色框的比例）+ 气泡锚点；来自角色包 manifest 的 `layout`。 */
export interface PackHitboxes {
  regions: Record<string, HitboxRegion>;
  bubbleAnchor?: { x: number; y: number };
}

export interface MascotRegistryLike {
  current(): Pick<MascotBackend, 'lookAt'> | null;
}

const REGION_ORDER: BodyRegion[] = ['face', 'head', 'hands', 'hem', 'legs', 'body'];

function mapPackId(id: string): BodyRegion | null {
  if (id === 'hand') return 'hands';
  if (id === 'skirt') return 'hem';
  if ((REGION_ORDER as string[]).includes(id)) return id as BodyRegion;
  return null;
}

/**
 * Hit-test using pack `layout/hitboxes.json` ratios of the character box.
 * More specific regions (face/head/hands/hem) win over body.
 */
export function regionFromHitboxes(
  x: number,
  y: number,
  charBox: Box,
  hitboxes: PackHitboxes,
): BodyRegion | null {
  const w = Math.max(1, charBox.right - charBox.left);
  const h = Math.max(1, charBox.bottom - charBox.top);
  const nx = (x - charBox.left) / w;
  const ny = (y - charBox.top) / h;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  let best: BodyRegion | null = null;
  let bestRank = REGION_ORDER.length;
  for (const [id, r] of Object.entries(hitboxes.regions || {})) {
    const region = mapPackId(id);
    if (!region || !r) continue;
    if (nx >= r.left && nx <= r.right && ny >= r.top && ny <= r.bottom) {
      const rank = REGION_ORDER.indexOf(region);
      if (rank >= 0 && rank < bestRank) {
        best = region;
        bestRank = rank;
      }
    }
  }
  return best;
}

/** Synthesize a small head box around pack bubbleAnchor (ratios of character box). */
export function bubbleAnchorBox(charBox: Box, hitboxes: PackHitboxes | null): Box | null {
  const a = hitboxes?.bubbleAnchor;
  if (!a) return null;
  const w = Math.max(1, charBox.right - charBox.left);
  const h = Math.max(1, charBox.bottom - charBox.top);
  const cx = charBox.left + a.x * w;
  const cy = charBox.top + a.y * h;
  const hw = w * 0.12;
  const hh = h * 0.08;
  return { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh };
}

/** Body region of a point on the 2D figure (pure; drives hover / click reactions). */
export function regionInSprite(
  x: number,
  y: number,
  head: Box | null,
  body: Box | null,
  hitboxes?: PackHitboxes | null,
  charBox?: Box | null,
): BodyRegion {
  if (hitboxes && charBox) {
    const fromPack = regionFromHitboxes(x, y, charBox, hitboxes);
    if (fromPack) return fromPack;
  }
  if (head && x >= head.left && x <= head.right && y >= head.top && y <= head.bottom) {
    // upper ~45% of the head box is hair / crown, the rest is the face
    return y < head.top + (head.bottom - head.top) * 0.45 ? 'head' : 'face';
  }
  if (body) {
    const w = body.right - body.left;
    const top = head ? head.bottom : body.top;
    const h = Math.max(1, body.bottom - top);
    if (x < body.left + w * 0.2 || x > body.right - w * 0.2) return 'hands';
    if (y > top + h * 0.6) return 'hem';
  }
  return 'body';
}
