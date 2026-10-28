/**
 * Named parameter bag for the Nomi 2D layered rig.
 *
 * Every pose is a set of named, bounded parameters. Actions (keyframe tracks) write parameters,
 * the animator reads them. Values live in one preallocated Float32Array so the per-frame hot path
 * never allocates.
 *
 * Continuous parameters blend additively around their default; DISCRETE parameters (expression
 * codes, hand shapes …) take the value of the highest-weight action that drives them.
 */

export interface ParamDef {
  name: string;
  def: number;
  min: number;
  max: number;
  /** discrete codes (highest-weight action wins, no interpolation) */
  discrete?: boolean;
  /** amplitude is scaled down under reduced motion (body movement), 1 = untouched */
  rm?: number;
}

/** Eye state codes (per eye). 0 = automatic (idle layer decides: open + blinks). */
export const EYE = {
  auto: 0,
  half: 1,
  closed: 2,
  happy: 3,
  wide: 4,
  sad: 5,
  determined: 6,
  /** soft ^ ^ with a smile line, for sleepy: lids low */
  sleepy: 7,
} as const;
export type EyeName = keyof typeof EYE;

/** Mouth codes. 0 = automatic (closed / lip-sync / expression default). */
export const MOUTH = {
  auto: 0,
  closed: 1,
  smile: 2,
  open: 3,
  o: 4,
  frown: 5,
  wavy: 6,
  cat: 7,
  tongue: 8,
  grin: 9,
  yawn: 10,
  pout: 11,
} as const;
export type MouthName = keyof typeof MOUTH;

/** Brow codes. 0 = none (the artwork has no brows, they only appear for expressions). */
export const BROW = { none: 0, up: 1, down: 2, worried: 3, angry: 4, soft: 5 } as const;
export type BrowName = keyof typeof BROW;

/** Hand shape codes → hand pieces (see manifest rig.hands). 0 = rigid master arm (no hand piece). */
export const HAND = {
  none: 0,
  wave: 1,
  fist: 2,
  thumbsup: 3,
  point: 4,
  rest: 5,
  peace: 6,
  prayer: 7,
  ok: 8,
  chest: 9,
} as const;
export type HandName = keyof typeof HAND;
export const HAND_NAMES = [
  '',
  'wave',
  'fist',
  'thumbsup',
  'point',
  'rest',
  'peace',
  'prayer',
  'ok',
  'chest',
] as const;

const D = (
  name: string,
  def: number,
  min: number,
  max: number,
  extra: Partial<ParamDef> = {},
): ParamDef => ({ name, def, min, max, ...extra });

export const PARAM_DEFS: readonly ParamDef[] = [
  // body (px / degrees, added on top of the idle layer)
  D('bodyY', 0, -40, 40, { rm: 0.3 }),
  D('torsoRot', 0, -10, 10, { rm: 0.3 }),
  D('torsoX', 0, -40, 40, { rm: 0.3 }),
  D('scale', 0, -0.08, 0.08, { rm: 0.3 }),
  D('shoulder', 0, -30, 30, { rm: 0.4 }),
  // head
  D('headRot', 0, -30, 30, { rm: 0.5 }),
  D('headNod', 0, -20, 24, { rm: 0.5 }),
  D('headX', 0, -40, 40, { rm: 0.4 }),
  D('gazeX', 0, -1, 1),
  D('gazeY', 0, -1, 1),
  // arms: a = shoulder lift outward/up (deg), e = elbow bend (deg), w = wrist twist (deg)
  D('rOn', 0, 0, 1),
  D('rA', 0, -110, 150),
  D('rE', 0, -140, 230),
  D('rW', 0, -90, 90),
  D('rHand', 0, 0, 9, { discrete: true }),
  /** derived by the animator (never keyed): forearm foreshortening while the arm swings, 0..1 */
  D('rF', 0, 0, 1),
  D('lOn', 0, 0, 1),
  D('lA', 0, -110, 150),
  D('lE', 0, -140, 230),
  D('lW', 0, -90, 90),
  D('lHand', 0, 0, 9, { discrete: true }),
  D('lF', 0, 0, 1),
  /** 1 = arms are drawn in front of the head (hand over face / chin) */
  D('armFront', 0, 0, 1, { discrete: true }),
  // face
  D('eyeL', 0, 0, 7, { discrete: true }),
  D('eyeR', 0, 0, 7, { discrete: true }),
  D('brow', 0, 0, 5, { discrete: true }),
  D('mouth', 0, 0, 11, { discrete: true }),
  D('blush', 0, 0, 1),
  D('lookAway', 0, 0, 1),
  // vector effects (strength 0..1)
  D('fxHeart', 0, 0, 1),
  D('fxSparkle', 0, 0, 1),
  D('fxQuestion', 0, 0, 1),
  D('fxExclaim', 0, 0, 1),
  D('fxSweat', 0, 0, 1),
  D('fxTear', 0, 0, 1),
  D('fxAnger', 0, 0, 1),
  D('fxNote', 0, 0, 1),
  D('fxZzz', 0, 0, 1),
  D('fxStar', 0, 0, 1),
  D('fxBlush', 0, 0, 1),
  D('fxGloom', 0, 0, 1),
];

export const PARAM_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  PARAM_DEFS.map((p, i) => [p.name, i]),
);
export const PARAM_COUNT = PARAM_DEFS.length;

export type ParamName = (typeof PARAM_DEFS)[number]['name'];

/** One value per parameter; reused every frame. */
export class ParamBag {
  readonly v = new Float32Array(PARAM_COUNT);
  constructor() {
    this.reset();
  }
  reset(): void {
    for (let i = 0; i < PARAM_COUNT; i++) this.v[i] = PARAM_DEFS[i].def;
  }
  get(name: string): number {
    return this.v[PARAM_INDEX[name]] ?? 0;
  }
}

/** Parameter indices by name (hot-path friendly). */
export const IDX = PARAM_INDEX as Readonly<Record<string, number>>;
