/**
 * Pseudo-3D layered 2D rig (parameter-driven layers, no WebGL).
 *
 * A rig is a handful of transparent PNG layers cut from one illustration
 * (body, head, side hair, ribbon, eyes, mouth + painted variants). The
 * animator below turns mascot state (expression / mouth / blink / look)
 * into per-layer transforms; `drawRig` paints them with Canvas2D only.
 */

import { ActionManager } from './rig/actionManager';
import { ACTIONS } from './rig/actions';
import { drawBrow, drawFx, drawMouth } from './rig/fx';
import {
  ARM_HAND_S,
  armFrame,
  bodyShoulderFill,
  bodySideFill,
  drawArmPieces,
  drawHandPiece,
  handScaleFor,
  shoulderPlug,
  type ArmGeom,
  type HandPieceMeta,
} from './rig/meshArm';
import { HAND_NAMES, IDX, PARAM_DEFS, type ParamBag } from './rig/params';
import type { RigImageSource } from './rig/rigTypes';

export interface RigEyeMetrics {
  /** eye opening bbox in rig px */
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** upper lash stroke thickness (rig px) */
  lash: number;
  /** tight under-lash oval used to hard-clip the travelling iris */
  ovalX0?: number;
  ovalX1?: number;
  ovalTop?: number;
  ovalBottom?: number;
}

export interface RigManifest {
  /** Rig canvas size in px (all anchors/offsets live in this space). */
  size: [number, number];
  /** Named pivots, e.g. neck, eyeL, eyeR, mouth, hairL, hairR, ribbon, cheekL, cheekR, headTop. */
  anchors: Record<string, [number, number]>;
  /** iris radius per eye (rig px), for hi-res eyes with movable irises */
  irisRadius?: { l?: number; r?: number };
  /** eye-opening metrics; when present lids are drawn procedurally (descending lid blink) */
  eyes?: { l?: RigEyeMetrics; r?: RigEyeMetrics };
  /** colour of the lash / closed-eye line */
  lashColor?: string;
  /** rotation pivots of body parts (arm-l, arm-r, badge, strap-r …) */
  pivots?: Record<string, [number, number]>;
  /**
   * Layer name → top-left offset of its (trimmed) PNG in rig space, plus an optional
   * draw scale (e.g. 0.5 for hi-res face layers authored at 2× rig density).
   * Files are `${dir}${name}.png`.
   */
  layers: Record<string, [number, number] | [number, number, number]>;
  /** Folder (relative to manifest) holding the layer PNGs. */
  dir?: string;
  /** Spine / bounds of the master arm layers, for the mesh-warped arms. */
  arms?: { l?: ArmGeom; r?: ArmGeom };
  /** Hand pieces (name → meta); images are keyed `hand-${name}`. */
  hands?: Record<string, HandPieceMeta>;
}

export type EyeVariant = 'open' | 'happy';
export type MouthVariant = 'closed' | 'open' | 'o' | 'frown';

export interface RigGesture {
  name: string;
  /** changes every time the gesture is (re)triggered */
  id: number;
  /** action queue hints (see rig/actionManager) */
  priority?: 0 | 1 | 2 | 3;
  hold?: boolean;
  queue?: boolean;
  force?: boolean;
  /** `release` ends a held action instead of starting one */
  release?: boolean;
}

export interface RigInput {
  expression: string;
  /** 0..1 from lip sync (RMS) */
  mouth: number;
  talking: boolean;
  /** extra external blink envelope, 0 = open … 1 = closed (the animator also blinks on its own) */
  blink: number;
  lookX: number;
  lookY: number;
  reducedMotion?: boolean;
  /** one-shot body gesture (nod, wave, bow, jump, stomp, think …) */
  gesture?: RigGesture | null;
  /** AI is generating: hold a thinking tilt */
  thinking?: boolean;
}

export interface EyeMix {
  /** upper-lid descent 0 open … 1 closed (blink included) */
  cl: number;
  /** ^ ^ blend 0..1 */
  happy: number;
  /** >0 outer end lower (sad), <0 inner end lower (determined) */
  slope: number;
  scale: number;
  lidAlpha: number;
}

export interface RigPose {
  bodyY: number;
  bodyScaleY: number;
  /** torso weight shift / lean (rig px, rad), pivoting at the hips */
  torsoX: number;
  torsoRot: number;
  /** whole-figure scale (jump back = slightly smaller) */
  figureScale: number;
  /** shoulder lift, negative = up (rig px) */
  shoulderL: number;
  shoulderR: number;
  armRotL: number;
  armRotR: number;
  badgeRot: number;
  strapRot: number;
  headX: number;
  headY: number;
  headRot: number;
  featX: number;
  featY: number;
  /** iris offset inside the eye, -1..1 (scaled by the iris radius) */
  irisX: number;
  irisY: number;
  hairRotL: number;
  hairRotR: number;
  ribbonRot: number;
  /** vertical eye scale, 1 open … 0 closed (legacy squash rigs) */
  eyeOpen: number;
  /** upper-lid descent, 0 open … 1 closed */
  lidClose: number;
  eyeScale: number;
  eyeVariant: EyeVariant;
  /** 0..1 blend toward the happy ^^ eyes */
  happy: number;
  /** alpha of the closed-lid line */
  lidAlpha: number;
  mouthVariant: MouthVariant;
  mouthOpen: number;
  /** viseme width factor (≈0.8 round … 1.15 wide) */
  mouthWidth: number;
  blush: number;
  tint: { r: number; g: number; b: number; a: number };
  angerMark: number;
  sweat: number;
  /** subtle bangs lift (0..1) — never draws a second brow */
  browRaise: number;
  /** cheek soft squash on smile (0..1) */
  cheekSquash: number;
  /** per-eye state (lid closure, ^ ^ blend, slant, size) — action driven, smoothed */
  eyeL?: EyeMix;
  eyeR?: EyeMix;
  /** eased brow stroke alpha (0 = none) and the brow shape code */
  browAlpha?: number;
  browKind?: number;
  reduced?: boolean;
  /** action parameters (arms, face states, effects) — see rig/params.ts */
  ext?: ParamBag | null;
  /** seconds (animation clock for vector effects) */
  time?: number;
}

interface ExprStyle {
  eyeOpen: number;
  eyeScale: number;
  eyeVariant: EyeVariant;
  mouth: MouthVariant;
  mouthBase: number;
  tilt: number; // deg
  headY: number;
  blush: number;
  tint: [number, number, number, number];
  breathRate: number;
  anger: number;
  sweat: number;
  /** held body posture */
  slump: number;
  /** one-shot gesture fired when the expression starts */
  gesture?: string;
}

const BASE: ExprStyle = {
  eyeOpen: 1,
  eyeScale: 1,
  eyeVariant: 'open',
  mouth: 'closed',
  mouthBase: 0,
  tilt: 0,
  headY: 0,
  blush: 0.15,
  tint: [0, 0, 0, 0],
  breathRate: 1,
  anger: 0,
  sweat: 0,
  slump: 0,
};

export const EXPRESSION_STYLES: Record<string, ExprStyle> = {
  neutral: BASE,
  talking: BASE,
  blink: BASE,
  happy: {
    ...BASE,
    eyeVariant: 'happy',
    mouth: 'open',
    mouthBase: 0.5,
    tilt: 4,
    headY: -1,
    blush: 0.72,
    breathRate: 1.35,
    gesture: 'celebrate',
  },
  relaxed: {
    ...BASE,
    eyeOpen: 0.52,
    eyeScale: 0.97,
    tilt: -3,
    headY: 2.5,
    blush: 0.4,
    breathRate: 0.7,
  },
  sad: {
    ...BASE,
    eyeOpen: 0.62,
    mouth: 'frown',
    tilt: -3,
    headY: 6,
    blush: 0,
    tint: [70, 110, 200, 0.09],
    breathRate: 0.65,
    sweat: 1,
    slump: 1,
  },
  angry: {
    ...BASE,
    eyeOpen: 0.8,
    mouth: 'frown',
    tilt: 1.5,
    headY: -1,
    blush: 0.55,
    tint: [230, 60, 40, 0.1],
    breathRate: 1.5,
    anger: 1,
    gesture: 'stomp',
  },
  surprised: {
    ...BASE,
    eyeOpen: 1,
    eyeScale: 1.14,
    mouth: 'o',
    mouthBase: 0.72,
    headY: -5,
    blush: 0.28,
    breathRate: 1.45,
    gesture: 'jump',
  },
  shy: {
    ...BASE,
    eyeOpen: 0.7,
    tilt: -4,
    headY: 3,
    blush: 0.85,
    breathRate: 1.1,
    gesture: 'shy',
  },
};

export function expressionStyle(name: string): ExprStyle {
  return EXPRESSION_STYLES[name] ?? BASE;
}

function approach(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const x = clamp01((v - a) / (b - a));
  return x * x * (3 - 2 * x);
};
const easeInOut = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(x));

/** deterministic hash → [0,1) */
function hash1(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** 1-D gradient noise, roughly −1..1, C1-smooth. */
export function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const g0 = hash1(i) * 2 - 1;
  const g1 = hash1(i + 1) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return (g0 * f * (1 - u) + g1 * (f - 1) * u) * 2.2;
}

/** two-octave noise; `seed` offsets the lattice so channels stay uncorrelated */
const fbm = (x: number, seed: number) =>
  noise1(x + seed * 31.7) * 0.7 + noise1(x * 2.13 + seed * 17.3 + 5.1) * 0.3;

/** small seeded PRNG (mulberry32) so a run is reproducible */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Spring-damper: stiffness k, damping ratio zeta (1 = critical, no overshoot). */
export class Spring {
  x = 0;
  v = 0;
  private c: number;
  constructor(
    private k: number,
    zeta: number,
  ) {
    this.c = 2 * zeta * Math.sqrt(k);
  }
  step(target: number, dt: number): number {
    // semi-implicit Euler, sub-stepped for stiff springs / long frames
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += ((target - this.x) * this.k - this.v * this.c) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  reset(x = 0) {
    this.x = x;
    this.v = 0;
  }
}

const DEG = Math.PI / 180;

/** Blink envelope (seconds since start) → lid closure 0..1, ≈170 ms, slower reopen. */
export function blinkCurve(tau: number): number {
  const CLOSE = 0.06;
  const HOLD = 0.025;
  const OPEN = 0.085;
  if (tau < 0) return 0;
  if (tau < CLOSE) return easeInOut(tau / CLOSE);
  if (tau < CLOSE + HOLD) return 1;
  if (tau < CLOSE + HOLD + OPEN) return 1 - easeInOut((tau - CLOSE - HOLD) / OPEN);
  return 0;
}
export const BLINK_DURATION = 0.17;

interface GestureOut {
  bodyY: number;
  headY: number;
  headRot: number;
  shoulder: number;
  torsoX: number;
  torsoRot: number;
  armOut: number;
  armR: number;
  scale: number;
  nodHead: number;
}
const ZERO_G: GestureOut = {
  bodyY: 0,
  headY: 0,
  headRot: 0,
  shoulder: 0,
  torsoX: 0,
  torsoRot: 0,
  armOut: 0,
  armR: 0,
  scale: 0,
  nodHead: 0,
};

const pulse = (x: number) => (x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x));

/** One-shot gesture curves (time τ in s). Returns null once finished. */
export function gestureCurve(name: string, tau: number): GestureOut | null {
  const g = { ...ZERO_G };
  switch (name) {
    case 'hop': {
      const D = 0.95;
      if (tau > D) return null;
      const decay = 1 - tau / D;
      g.bodyY = -10 * Math.abs(Math.sin((Math.PI * tau) / 0.4)) * decay;
      g.shoulder = -5.5 * pulse(tau / 0.5);
      g.headRot = 2.2 * DEG * pulse(tau / 0.9);
      g.armOut = 2.2 * DEG * pulse(tau / 0.5);
      return g;
    }
    case 'cheer':
    case 'celebrate': {
      const D = 1.15;
      if (tau > D) return null;
      const decay = 1 - tau / D;
      g.bodyY = -12 * Math.abs(Math.sin((Math.PI * tau) / 0.38)) * decay;
      g.shoulder = -7 * pulse(tau / 0.55);
      g.headRot = 3.5 * DEG * pulse(tau / D);
      g.armOut = 3.5 * DEG * pulse(tau / 0.55);
      g.scale = 0.012 * pulse(tau / 0.5);
      return g;
    }
    case 'clap': {
      const D = 1.05;
      if (tau > D) return null;
      const env = pulse(tau / D);
      // light bounce + inward arm pulse (art range is small)
      g.bodyY = -6 * Math.abs(Math.sin((Math.PI * tau) / 0.28)) * (1 - tau / D);
      g.shoulder = -4 * env;
      g.armOut = 2.8 * DEG * Math.abs(Math.sin(tau * 14)) * env;
      g.headRot = 1.5 * DEG * env;
      return g;
    }
    case 'jump':
    case 'flinch':
    case 'shake': {
      const D = 0.95;
      if (tau > D) return null;
      const k = tau < 0.1 ? easeInOut(tau / 0.1) : Math.exp(-(tau - 0.1) * 5.5);
      g.bodyY = -12 * k;
      g.headY = -5.5 * k;
      g.scale = -0.032 * k;
      g.shoulder = -6.5 * k;
      g.armOut = 2.4 * DEG * k;
      return g;
    }
    case 'stomp': {
      const D = 0.95;
      if (tau > D) return null;
      const s1 = pulse(tau / 0.16);
      const s2 = pulse((tau - 0.34) / 0.16);
      g.bodyY = 5.5 * (s1 + s2 * 0.9);
      g.shoulder = -3.5 * (s1 + s2);
      g.torsoX = Math.sin(tau * 34) * 2.6 * (1 - tau / D);
      g.headRot = Math.sin(tau * 31) * 1.8 * DEG * (1 - tau / D);
      return g;
    }
    case 'nod':
    case 'greet': {
      const D = 1.05;
      if (tau > D) return null;
      g.nodHead = 8 * pulse(tau / 0.4) + 5 * pulse((tau - 0.48) / 0.42);
      g.shoulder = -2 * pulse(tau / 0.4);
      g.torsoRot = 0.4 * DEG * pulse(tau / D);
      return g;
    }
    case 'wave': {
      const D = 1.45;
      if (tau > D) return null;
      const env = pulse(tau / D);
      g.nodHead = 5.5 * pulse(tau / 0.45);
      g.headRot = 3.5 * DEG * env;
      g.shoulder = -3.5 * env;
      g.armR = Math.sin(tau * 12) * 4.2 * DEG * env;
      g.bodyY = -3.5 * Math.abs(Math.sin((Math.PI * tau) / 0.65)) * env;
      g.torsoRot = 0.8 * DEG * env;
      return g;
    }
    case 'bow': {
      const D = 1.55;
      if (tau > D) return null;
      const env = easeInOut(tau / 0.45) * (tau < 0.9 ? 1 : 1 - easeInOut((tau - 0.9) / 0.65));
      g.nodHead = 13 * env;
      g.bodyY = 3.5 * env;
      g.torsoRot = 1.2 * DEG * env;
      g.scale = -0.01 * env;
      return g;
    }
    case 'think': {
      const D = 1.7;
      if (tau > D) return null;
      const env = pulse(tau / D);
      g.headRot = -5.5 * DEG * env;
      g.torsoRot = -0.9 * DEG * env;
      g.shoulder = 1.2 * env;
      return g;
    }
    case 'shrug': {
      const D = 1.2;
      if (tau > D) return null;
      const env = pulse(tau / D);
      g.shoulder = -8 * env;
      g.headRot = 2 * DEG * env;
      g.armOut = 2.5 * DEG * env;
      g.torsoRot = 0.5 * DEG * Math.sin(tau * 6) * env;
      return g;
    }
    case 'look_around': {
      const D = 2.2;
      if (tau > D) return null;
      const env = pulse(tau / D);
      g.headRot = Math.sin(tau * 3.2) * 7 * DEG * env;
      g.torsoRot = Math.sin(tau * 3.2) * 1.4 * DEG * env;
      g.torsoX = Math.sin(tau * 3.2) * 4 * env;
      g.nodHead = Math.sin(tau * 5) * 2 * env;
      return g;
    }
    case 'shy': {
      const D = 1.4;
      if (tau > D) return null;
      const env = pulse(tau / D);
      g.headRot = -6 * DEG * env;
      g.torsoRot = -1.2 * DEG * env;
      g.nodHead = 3 * env;
      g.shoulder = 2 * env;
      // arms tuck slightly (cover-ish within art range)
      g.armOut = -1.5 * DEG * env;
      return g;
    }
    case 'point': {
      const D = 1.3;
      if (tau > D) return null;
      const env = pulse(tau / D);
      g.armR = 5 * DEG * env;
      g.shoulder = -3 * env;
      g.headRot = 2.5 * DEG * env;
      g.torsoRot = 1.0 * DEG * env;
      g.nodHead = -1.5 * env;
      return g;
    }
    default:
      return null;
  }
}

/**
 * Stateful animator: call `step(dt, t, input)` once per frame.
 * Motion = layered noise + spring-dampers (no bare sine loops), so it never looks periodic.
 */
export class RigAnimator {
  private s = {
    eyeBase: 0,
    eyeScale: 1,
    tilt: 0,
    headY: 0,
    blush: 0.15,
    tr: 0,
    tg: 0,
    tb: 0,
    ta: 0,
    anger: 0,
    sweat: 0,
    happy: 0,
    slump: 0,
    think: 0,
    energy: 0,
    mouth: 0,
    breathPhase: 0,
  };
  private rand: () => number;
  // gaze: eyes jump (saccades), head follows with a critically damped lag
  private eyeGoalX = 0;
  private eyeGoalY = 0;
  private eyeX = new Spring(1400, 1);
  private eyeY = new Spring(1400, 1);
  private headLX = new Spring(22, 1.0);
  private headLY = new Spring(22, 1.0);
  private nextSaccade = 0.55;
  // blinks
  private blinkStarts: number[] = [];
  private nextBlink = 1.8;
  private lastBlink = -10;
  // body — softer lean/shift springs restore the v4 “weighty” sway feel
  private shift = 0;
  private nextShift = 5;
  private shiftS = new Spring(3.2, 1);
  private lean = new Spring(20, 0.92);
  private bobS = new Spring(110, 0.7);
  private armL = new Spring(32, 0.55);
  private armR = new Spring(30, 0.55);
  private badge = new Spring(22, 0.45);
  private strap = new Spring(28, 0.5);
  private hairL = new Spring(70, 0.85);
  private hairR = new Spring(70, 0.85);
  private ribbon = new Spring(70, 0.85);
  private browS = new Spring(18, 1);
  private cheekS = new Spring(14, 1);
  private nextHairFlick = 4;
  private prev = { headRot: 0, headX: 0, headY: 0, torsoX: 0, bodyY: 0, vX: 0, vY: 0 };
  private gesture: { name: string; t0: number } | null = null;
  private gestureId = -1;
  private lastExpr = 'neutral';
  private started = false;
  /** keyframe actions (arms, face states, effects) blended on top of the idle layer */
  readonly actions = new ActionManager(ACTIONS);
  /** follow-through: action parameters pass through springs so keyframes never read as robotic */
  private sprung = (
    [
      ['headRot', 256, 0.55],
      ['headNod', 324, 0.6],
      ['headX', 196, 0.7],
      ['torsoRot', 100, 0.6],
      ['torsoX', 81, 0.7],
      ['bodyY', 121, 0.6],
      ['shoulder', 144, 0.6],
      ['scale', 100, 0.7],
      ['rA', 196, 0.5],
      ['rE', 196, 0.5],
      ['rW', 225, 0.45],
      ['lA', 196, 0.5],
      ['lE', 196, 0.5],
      ['lW', 225, 0.45],
    ] as const
  ).map(([n, k, z]) => ({ idx: IDX[n], sp: new Spring(k, z) }));
  private armPrev = { rA: 0, rE: 0, lA: 0, lE: 0 };
  private foreS = { r: 0, l: 0 };
  private lift = { r: 0, l: 0 };
  private eyeMixL: EyeMix = { cl: 0, happy: 0, slope: 0, scale: 1, lidAlpha: 0 };
  private eyeMixR: EyeMix = { cl: 0, happy: 0, slope: 0, scale: 1, lidAlpha: 0 };
  // smoothed per-eye extras: closure, ^ ^, slope, scale
  private eyeExtra = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]);
  private browA = 0;
  private browK = 0;

  constructor(seed = 7) {
    this.rand = rng(seed);
  }

  private trigger(name: string, t: number) {
    if (gestureCurve(name, 0)) this.gesture = { name, t0: t };
  }

  /** blink closure 0..1 from the blink scheduler (auto, double, on gaze shift) */
  private blinkAt(t: number): number {
    let c = 0;
    for (const b of this.blinkStarts) c = Math.max(c, blinkCurve(t - b));
    this.blinkStarts = this.blinkStarts.filter((b) => t - b < BLINK_DURATION + 0.3);
    return c;
  }
  private startBlink(t: number, allowDouble = true) {
    if (t - this.lastBlink < 0.35) return;
    this.lastBlink = t;
    this.blinkStarts.push(t);
    if (allowDouble && this.rand() < 0.16) this.blinkStarts.push(t + 0.24);
  }

  private stepEye(o: number, code: number, dt: number) {
    const ex = this.eyeExtra;
    let tc = 0;
    let th = 0;
    let tsl = 0;
    let tsc = 1;
    switch (code) {
      case 1:
        tc = 0.45;
        break;
      case 2:
        tc = 1;
        break;
      case 3:
        th = 1;
        break;
      case 4:
        tsc = 1.12;
        break;
      case 5:
        tc = 0.22;
        tsl = 1;
        break;
      case 6:
        tc = 0.2;
        tsl = -1;
        break;
      case 7:
        tc = 0.62;
        tsl = 0.3;
        break;
      default:
    }
    ex[o] = approach(ex[o], tc, 16, dt);
    ex[o + 1] = approach(ex[o + 1], th, 14, dt);
    ex[o + 2] = approach(ex[o + 2], tsl, 12, dt);
    ex[o + 3] = approach(ex[o + 3], tsc, 12, dt);
  }

  private fillEye(m: EyeMix, o: number, lidClose: number, happy: number) {
    const ex = this.eyeExtra;
    m.cl = Math.max(lidClose, ex[o]);
    m.happy = Math.max(happy, ex[o + 1]);
    m.slope = ex[o + 2];
    m.scale = this.s.eyeScale * ex[o + 3];
    m.lidAlpha = smooth(0.6, 0.95, m.cl) * (1 - m.happy);
  }

  /**
   * Overlapping action on top of the keyframes (never touches artwork, only parameters): springs
   * give overshoot / settle, arms drift a little while held, the torso leans away from a raised
   * arm and the shoulder lifts, and the forearm foreshortens while the arm swings.
   */
  private followThrough(pb: ParamBag, dt: number, t: number, rm: boolean): void {
    const v = pb.v;
    const busy = this.actions.busy();
    if (!busy || rm) {
      for (const e of this.sprung) e.sp.reset(v[e.idx]);
      this.foreS.r = this.foreS.l = this.lift.r = this.lift.l = 0;
      this.armPrev.rA = v[IDX.rA];
      this.armPrev.rE = v[IDX.rE];
      this.armPrev.lA = v[IDX.lA];
      this.armPrev.lE = v[IDX.lE];
      v[IDX.rF] = 0;
      v[IDX.lF] = 0;
      return;
    }
    for (const e of this.sprung) {
      const d = PARAM_DEFS[e.idx];
      v[e.idx] = Math.max(d.min, Math.min(d.max, e.sp.step(v[e.idx], dt)));
    }
    const inv = dt > 0 ? 1 / dt : 0;
    for (const side of ['r', 'l'] as const) {
      const on = v[IDX[`${side}On`]];
      const ia = IDX[`${side}A`];
      const ie = IDX[`${side}E`];
      const prevA = this.armPrev[`${side}A`];
      const prevE = this.armPrev[`${side}E`];
      const speed = (Math.abs(v[ie] - prevE) + 0.5 * Math.abs(v[ia] - prevA)) * inv;
      this.armPrev[`${side}A`] = v[ia];
      this.armPrev[`${side}E`] = v[ie];
      const speedFore = Math.max(0, Math.min(1, (speed - 40) / 300));
      // held raised poses also foreshorten so the cuff stays on-canvas
      const raiseFore = Math.max(
        Math.min(1, Math.abs(v[ia]) / 40),
        Math.min(1, Math.abs(v[ie]) / 110) * 0.5,
      );
      const target = Math.max(speedFore, raiseFore * 0.9) * (on > 0.01 ? 1 : 0);
      this.foreS[side] = approach(this.foreS[side], target, target > this.foreS[side] ? 28 : 9, dt);
      v[IDX[`${side}F`]] = this.foreS[side];
      // a held arm is never perfectly still
      const drift = on > 0.5 ? on : 0;
      if (drift) {
        const sd = side === 'r' ? 0 : 7;
        // tiny alive tremor only — large drift made sleeves look like paper flaps
        v[ia] += fbm(t * 0.45, 31 + sd) * 0.9 * drift;
        v[ie] += fbm(t * 0.55, 32 + sd) * 1.2 * drift;
        v[IDX[`${side}W`]] += fbm(t * 0.7, 33 + sd) * 1.6 * drift;
      }
      const raised = on * Math.max(0, Math.min(1, v[ia] / 45));
      this.lift[side] = approach(this.lift[side], raised, 6, dt);
    }
    // weight shifts away from the raised arm; the head tilts toward it
    const lr = this.lift.r;
    const ll = this.lift.l;
    v[IDX.torsoRot] += -1.3 * lr + 1.3 * ll;
    v[IDX.headRot] += 1.6 * lr - 1.6 * ll;
    v[IDX.bodyY] += -1.5 * Math.max(lr, ll);
    for (const n of ['rA', 'rE', 'rW', 'lA', 'lE', 'lW', 'torsoRot', 'headRot', 'bodyY']) {
      const d = PARAM_DEFS[IDX[n]];
      v[IDX[n]] = Math.max(d.min, Math.min(d.max, v[IDX[n]]));
    }
  }

  step(dt: number, t: number, input: RigInput): RigPose {
    const st = expressionStyle(input.expression);
    const rm = !!input.reducedMotion;
    const s = this.s;
    const m = rm ? 0 : 1;
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (!this.started) {
      this.started = true;
      this.nextBlink = t + 1.2 + this.rand() * 2;
      this.nextShift = t + 4 + this.rand() * 3.5;
      this.nextSaccade = t + 0.5;
      this.nextHairFlick = t + 2.5 + this.rand() * 3;
    }

    // --- events → gestures
    if (input.expression !== this.lastExpr) {
      if (st.gesture) this.trigger(st.gesture, t);
      this.lastExpr = input.expression;
    }
    this.actions.reducedMotion = rm;
    if (input.gesture && input.gesture.id !== this.gestureId) {
      this.gestureId = input.gesture.id;
      const ge = input.gesture;
      if (ge.release) this.actions.release(ge.name === '*' ? undefined : ge.name);
      else if (this.actions.has(ge.name))
        this.actions.play(ge.name, {
          priority: ge.priority,
          hold: ge.hold,
          queue: ge.queue,
          force: ge.force ?? true,
        });
      else this.trigger(ge.name, t);
    }
    const pb = this.actions.update(dt);
    const av = pb.v;
    const actionOn = this.actions.busy();
    this.followThrough(pb, dt, t, rm);
    const g = (this.gesture && gestureCurve(this.gesture.name, t - this.gesture.t0)) || ZERO_G;
    if (this.gesture && g === ZERO_G) this.gesture = null;

    // --- eased expression parameters
    s.eyeBase = approach(s.eyeBase, (1 - st.eyeOpen) * 0.85, 7, dt);
    s.eyeScale = approach(s.eyeScale, st.eyeScale, 10, dt);
    s.tilt = approach(s.tilt, st.tilt, 3.5, dt);
    s.headY = approach(s.headY, st.headY, 4, dt);
    s.blush = approach(s.blush, st.blush, 3, dt);
    s.tr = approach(s.tr, st.tint[0], 5, dt);
    s.tg = approach(s.tg, st.tint[1], 5, dt);
    s.tb = approach(s.tb, st.tint[2], 5, dt);
    s.ta = approach(s.ta, st.tint[3], 3, dt);
    s.anger = approach(s.anger, st.anger, 5, dt);
    s.sweat = approach(s.sweat, st.sweat, 2.5, dt);
    s.happy = approach(s.happy, st.eyeVariant === 'happy' ? 1 : 0, 14, dt);
    s.slump = approach(s.slump, st.slump, 2.2, dt);
    s.think = approach(s.think, input.thinking ? 1 : 0, 3, dt);

    // --- gaze: saccadic eyes lead, head follows on a no-overshoot spring
    const thinkLook = s.think;
    const goalX = input.lookX * (1 - thinkLook) - 0.45 * thinkLook + av[IDX.gazeX];
    const goalY = input.lookY * (1 - thinkLook) + 0.55 * thinkLook + av[IDX.gazeY];
    const jump = Math.hypot(goalX - this.eyeGoalX, goalY - this.eyeGoalY);
    if (jump > 0.12) {
      if (jump > 0.55 && this.rand() < 0.6) this.startBlink(t, false);
      this.eyeGoalX = goalX;
      this.eyeGoalY = goalY;
      this.nextSaccade = t + 0.5 + this.rand() * 1.4;
    } else if (t >= this.nextSaccade) {
      // idle micro-saccade / dart between blinks
      this.eyeGoalX = goalX + (this.rand() - 0.5) * 0.22 * m;
      this.eyeGoalY = goalY + (this.rand() - 0.5) * 0.14 * m;
      this.nextSaccade = t + 0.45 + this.rand() * 1.5;
    }
    const eyeX = this.eyeX.step(this.eyeGoalX, dt);
    const eyeY = this.eyeY.step(this.eyeGoalY, dt);
    const lookX = this.headLX.step(goalX, dt);
    const lookY = this.headLY.step(goalY, dt);

    // --- blinks (also with reduced motion)
    if (t >= this.nextBlink) {
      this.startBlink(t);
      this.nextBlink = t + 2.2 + this.rand() * 3.8;
    }
    const blink = Math.max(this.blinkAt(t), clamp01(input.blink));

    // --- speech: asymmetric envelope (fast attack, slower release) + viseme width
    const speaking = input.talking || input.mouth > 0.04;
    const raw = speaking ? Math.max(input.mouth, input.talking ? 0.1 : 0) : 0;
    s.energy = approach(s.energy, raw, raw > s.energy ? 28 : 11, dt);
    const mouthTarget = speaking ? s.energy : st.mouthBase;
    s.mouth = approach(s.mouth, mouthTarget, speaking ? 30 : 10, dt);
    const mouthWidth = speaking ? 1 + 0.16 * fbm(t * 5.5, 9) - 0.08 * s.energy : 1;
    const bob = this.bobS.step(s.energy * 4.5 * m, dt);

    // --- breathing: noise-modulated rate, inhale quicker than exhale (richer chest+shoulder+head)
    s.breathPhase += dt * (0.26 + 0.04 * fbm(t * 0.1, 3)) * st.breathRate * Math.PI * 2;
    const ph = s.breathPhase % (Math.PI * 2);
    const breath =
      (ph < Math.PI * 0.82 ? -Math.cos(ph / 0.82) : Math.cos((ph - Math.PI * 0.82) / 1.18)) * m;

    // --- weight shift idle loop (slightly more frequent / larger)
    if (t >= this.nextShift) {
      this.shift = (this.shift > 0 ? -1 : 1) * (0.55 + this.rand() * 0.55);
      this.nextShift = t + 5.5 + this.rand() * 5.5;
    }
    const shift = this.shiftS.step(this.shift * m, dt);

    // --- idle micro-movements (richer noise; uncorrelated seeds)
    const nRot = fbm(t * 0.33, 1) * 1.85 * m;
    const nX = fbm(t * 0.25, 2) * 2.2 * m;
    const nY = fbm(t * 0.29, 4) * 1.25 * m;
    const nTalk = fbm(t * 1.9, 5) * 1.7 * Math.min(1, s.energy * 3) * m;
    const nTilt = fbm(t * 0.17, 21) * 0.9 * m; // random micro-tilts

    // occasional hair flick (secondary impulse)
    let flick = 0;
    if (t >= this.nextHairFlick && m) {
      flick = (this.rand() - 0.5) * 5.5 * DEG;
      this.nextHairFlick = t + 3.5 + this.rand() * 6;
    }

    const slump = s.slump;
    // Talking: lean slightly toward the user (look) + shoulder bounce
    const talkLean = speaking ? s.energy * m : 0;
    // Whole-body intent: torso leads; head adds a smaller share (smoother lean vs stiff same-frame lock)
    const intentRot =
      (s.tilt + nRot + nTilt + lookX * 3.6 * (1 - thinkLook) - 6 * s.think + nTalk - shift * 1.0) *
        DEG +
      g.headRot * m +
      av[IDX.headRot] * DEG +
      lookX * 0.8 * DEG * talkLean;
    const intentX = lookX * 12 + nX + shift * 2.0 + lookX * 2.5 * talkLean + av[IDX.headX];
    const intentY =
      s.headY - lookY * 5.5 + nY + bob + slump * 3 + (g.headY + g.nodHead) * m + av[IDX.headNod];

    // Slow idle sway through soft lean spring; intent torso share is higher for body-led lean
    const torsoIdle =
      (shift * 0.95 +
        fbm(t * 0.11, 6) * 0.55 +
        fbm(t * 0.21, 16) * 0.4 +
        fbm(t * 0.08, 22) * 0.25 +
        slump * 0.45) *
      DEG *
      m;
    const torsoRot =
      intentRot * 0.44 * m +
      this.lean.step(torsoIdle, dt) +
      g.torsoRot * m +
      av[IDX.torsoRot] * DEG +
      lookX * 0.6 * DEG * talkLean;
    const torsoX =
      (intentX * 0.52 + shift * 4.2 + fbm(t * 0.18, 17) * 1.7 + g.torsoX + lookX * 1.8 * talkLean) *
        m +
      av[IDX.torsoX];
    const bodyY =
      (g.bodyY + slump * 3 + Math.max(-7, Math.min(7, intentY * 0.48))) * m + av[IDX.bodyY];
    // richer breath: chest scale + head lift + shoulders
    const bodyScaleY = 1 + breath * 0.0072;
    const headRot = intentRot * 0.56;
    const headX = intentX * 0.48;
    const headY = intentY * 0.58 - breath * 1.35;
    const tiltSh = (torsoRot / DEG) * 1.85;
    const talkBob = talkLean * (1.8 + 1.2 * Math.abs(Math.sin(t * 9)));
    const sh = (-breath * 2.6 + g.shoulder + slump * 5 - talkBob) * m + av[IDX.shoulder];
    const shL = sh - tiltSh * m - 7 * this.lift.l * m;
    const shR = sh + tiltSh * m - 7 * this.lift.r * m;

    // brow micro-raise (expression + idle noise) — drives bangs lift only
    const browTarget =
      (st.eyeScale > 1 ? (st.eyeScale - 1) * 4 : 0) * 0.35 +
      (st.eyeVariant === 'happy' ? 0.15 : 0) +
      fbm(t * 0.4, 23) * 0.08 * m +
      (speaking ? 0.06 * s.energy : 0);
    const browRaise = this.browS.step(browTarget * m, dt);
    const cheekTarget = Math.max(s.blush * 0.55, s.happy * 0.7) + (speaking ? 0.08 * s.energy : 0);
    const cheekSquash = this.cheekS.step(cheekTarget * m, dt);

    // velocities drive inertia of hanging parts
    const inv = dt > 0 ? 1 / dt : 0;
    const vHeadRot = (headRot - this.prev.headRot) * inv;
    const vHeadX = (headX - this.prev.headX) * inv;
    const vX = (torsoX - this.prev.torsoX) * inv;
    const vY = (bodyY + headY * 0.3 - this.prev.bodyY) * inv;
    const aX = (vX - this.prev.vX) * inv;
    const aY = (vY - this.prev.vY) * inv;
    this.prev = { headRot, headX, headY, torsoX, bodyY: bodyY + headY * 0.3, vX, vY };

    // One shared hair angle (L/R/ribbon) so layers never peel into stacked cutouts.
    // Tiny static asymmetry only — no independent noise per piece.
    const hairDrive = (-vHeadRot * 0.045 - vHeadX * 0.0006) * m + flick * 0.12;
    const hairNoise = fbm(t * 0.28, 10) * 0.12 * DEG * m; // shared whisper
    const hairTarget = hairDrive + hairNoise;
    const lim = (v: number, l: number) => Math.max(-l, Math.min(l, v));
    // keep secondary hair angles tiny so layers stay a single silhouette
    const hairRotL = lim(this.hairL.step(hairTarget, dt), 2.5 * DEG);
    const hairRotR = lim(this.hairR.step(hairTarget + 0.15 * DEG * m, dt), 2.5 * DEG);
    const ribbonRot = lim(this.ribbon.step(hairTarget + 0.2 * DEG * m, dt), 3.5 * DEG);
    // Art-safe arm range (~5° idle; gestures up to ~8°)
    const armDrive = -aX * 0.00005 - torsoRot * 0.55;
    const armRotL = lim(
      this.armL.step(
        (armDrive + g.armOut + fbm(t * 0.32, 13) * 0.18 * DEG + slump * 0.4 * DEG) * m,
        dt,
      ),
      4.5 * DEG,
    );
    const armRotR = lim(
      this.armR.step(
        (armDrive - g.armOut + g.armR + fbm(t * 0.34, 14) * 0.18 * DEG - slump * 0.4 * DEG) * m,
        dt,
      ),
      4.5 * DEG,
    );
    const hang = -torsoRot - aX * 0.0003 + aY * 0.00012;
    const badgeRot = lim(
      this.badge.step(hang * m + fbm(t * 0.45, 18) * 0.4 * DEG * m, dt),
      9 * DEG,
    );
    const strapRot = lim(
      this.strap.step((hang * 0.85 + fbm(t * 0.48, 15) * 0.85 * DEG) * m, dt),
      7.5 * DEG,
    );

    const happy = s.happy;
    const lidClose = Math.min(1, s.eyeBase + blink * (1 - s.eyeBase));
    const eyeOpen = Math.max(0.02, 1 - lidClose);
    const lidAlpha = smooth(0.6, 0.95, lidClose) * (1 - happy);

    // --- action driven per-eye states (smoothed); automatic eyes keep the idle layer untouched
    this.stepEye(0, av[IDX.eyeL] | 0, dt);
    this.stepEye(4, av[IDX.eyeR] | 0, dt);
    this.fillEye(this.eyeMixL, 0, lidClose, happy);
    this.fillEye(this.eyeMixR, 4, lidClose, happy);
    const bCode = av[IDX.brow] | 0;
    if (bCode > 0) this.browK = bCode;
    this.browA = approach(this.browA, bCode > 0 ? 0.62 : 0, bCode > 0 ? 14 : 9, dt);

    let mouthVariant: MouthVariant = 'closed';
    if (s.mouth > 0.06) mouthVariant = st.mouth === 'o' ? 'o' : 'open';
    else if (st.mouth === 'frown') mouthVariant = 'frown';

    const pose: RigPose = {
      bodyY,
      bodyScaleY,
      torsoX,
      torsoRot,
      figureScale: 1 + g.scale * m + av[IDX.scale],
      shoulderL: shL,
      shoulderR: shR,
      armRotL,
      armRotR,
      badgeRot,
      strapRot,
      headX: rm ? lookX * 4 : headX,
      headY: rm ? s.headY * 0.5 : headY,
      headRot: rm ? s.tilt * 0.5 * DEG : headRot,
      // stronger feature parallax (eyes lead a bit more)
      featX: lookX * 5.2 + (eyeX - lookX) * 1.35,
      featY: -lookY * 3.6 - browRaise * 1.2,
      irisX: Math.max(-1, Math.min(1, eyeX * 1.25)),
      irisY: Math.max(-1, Math.min(1, -eyeY * 1.25)),
      hairRotL,
      hairRotR,
      ribbonRot,
      eyeOpen: happy > 0.5 ? 1 : eyeOpen,
      lidClose,
      eyeScale: s.eyeScale,
      eyeVariant: happy > 0.5 ? 'happy' : 'open',
      happy,
      lidAlpha,
      mouthVariant,
      mouthOpen: Math.min(1, s.mouth),
      mouthWidth,
      blush: Math.min(1, s.blush + av[IDX.blush] * 0.7),
      eyeL: this.eyeMixL,
      eyeR: this.eyeMixR,
      browAlpha: this.browA,
      browKind: this.browK,
      reduced: rm,
      time: t,
      ext: actionOn ? pb : null,
      tint: { r: s.tr, g: s.tg, b: s.tb, a: s.ta },
      angerMark: s.anger,
      sweat: s.sweat,
      browRaise,
      cheekSquash,
    };
    return pose;
  }
}

export type RigImages = Map<string, CanvasImageSource & { width: number; height: number }>;

/** Layers a rig needs for the full feature set (missing ones are skipped). */
export const RIG_LAYERS = [
  'body',
  'body-noarm',
  'arm-l',
  'arm-r',
  'strap-r',
  'badge',
  'head',
  'crown',
  'face-hd',
  'eye-white-l',
  'eye-white-r',
  'iris-l',
  'iris-r',
  'lash-l',
  'lash-r',
  'lid-l',
  'lid-r',
  'happy-l',
  'happy-r',
  // legacy single-plate eyes (older rigs)
  'eye-l',
  'eye-r',
  'eyes-closed',
  'eyes-happy',
  'mouth',
  'mouth-open',
  'mouth-o',
  'mouth-frown',
  'hair-side-l',
  'hair-side-r',
  'ribbon',
  'bangs',
  'clip',
  'earring',
] as const;

const scratches: (HTMLCanvasElement | OffscreenCanvas | undefined)[] = [];
function scratchCanvas(w: number, h: number, slot = 0) {
  let c = scratches[slot];
  if (!c) {
    c =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
    scratches[slot] = c;
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

type Eye = RigEyeMetrics;

/**
 * Anime-style lid stroke: thick tapered lash in the lash colour, outer-corner ticks,
 * a faint eyelid crease, and a tiny lower-lash hint. `kind` closed = gentle ∪,
 * happy = ∩ arc (^^).
 */
function lidStroke(
  ctx: CanvasRenderingContext2D,
  e: Eye,
  side: 'l' | 'r',
  y: number,
  kind: 'closed' | 'happy',
  color: string,
  alpha: number,
) {
  if (alpha <= 0.01) return;
  const w = e.x1 - e.x0;
  const h = e.bottom - e.top;
  const outerRight = side === 'r';
  const inner = outerRight ? e.x0 + w * 0.01 : e.x1 - w * 0.01;
  const outer = outerRight ? e.x1 + w * 0.1 : e.x0 - w * 0.1;
  const N = 22;
  const top: [number, number][] = [];
  const bot: [number, number][] = [];
  const at = (t: number) => {
    const x = inner + (outer - inner) * t;
    const yc =
      kind === 'closed'
        ? y + h * 0.18 * Math.sin(Math.PI * t) + h * 0.04 * t
        : y - h * 0.42 * Math.sin(Math.PI * Math.pow(t, 0.88)) + h * 0.03 * t;
    return [x, yc] as [number, number];
  };
  // thicker mid-lash, sharp taper at both ends (matches the open-eye source stroke)
  const thickness = (t: number) =>
    e.lash *
    (kind === 'closed' ? 1.28 : 1.18) *
    (0.12 + 0.88 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.68)), 0.62));
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const [x, yc] = at(t);
    const [x2, y2] = at(Math.min(1, t + 0.01));
    const [x1, y1] = at(Math.max(0, t - 0.01));
    let nx = -(y2 - y1);
    let ny = x2 - x1;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const th = thickness(t) / 2;
    top.push([x - nx * th, yc - ny * th]);
    bot.push([x + nx * th, yc + ny * th]);
  }
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(top[0][0], top[0][1]);
  for (const q of top) ctx.lineTo(q[0], q[1]);
  for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
  ctx.closePath();
  ctx.fill();
  // outer-corner ticks (winged clumps, matching the open-eye source)
  const dir = outerRight ? 1 : -1;
  const ticks =
    kind === 'closed'
      ? [
          [0.7, 0.09, 28],
          [0.82, 0.15, 40],
          [0.93, 0.13, 52],
        ]
      : [
          [0.88, 0.1, 28],
          [0.97, 0.12, 42],
        ];
  for (const [t, lenF, angDeg] of ticks) {
    const [x, yc] = at(t);
    const len = w * lenF;
    const ang = angDeg * DEG;
    const ex = x + dir * Math.cos(ang) * len;
    const ey = yc + Math.sin(ang) * len + (kind === 'closed' ? h * 0.02 : e.lash * 0.15);
    const bw = e.lash * 0.4;
    ctx.beginPath();
    ctx.moveTo(x - dir * bw * 0.6, yc - e.lash * 0.15);
    ctx.quadraticCurveTo(x + dir * len * 0.45, yc + len * 0.05, ex, ey);
    ctx.quadraticCurveTo(x + dir * len * 0.35, yc + len * 0.5, x + dir * bw, yc + bw * 0.8);
    ctx.closePath();
    ctx.fill();
  }
  // faint eyelid crease above the lash (gives the lid depth instead of a flat pale patch)
  ctx.globalAlpha *= 0.42;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.7, e.lash * 0.28);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    if (t < 0.08 || t > 0.92) continue;
    const [x, yc] = at(t);
    const cy = yc - h * (kind === 'closed' ? 0.22 : 0.18) * Math.sin(Math.PI * t);
    if (i === 0 || t <= 0.08 + 1 / N) ctx.moveTo(x, cy);
    else ctx.lineTo(x, cy);
  }
  ctx.stroke();
  // tiny lower-lash hints (closed only; happy arcs sit above)
  if (kind === 'closed') {
    ctx.globalAlpha = alpha * 0.55;
    ctx.lineWidth = Math.max(0.55, e.lash * 0.22);
    const lowerY = y + h * 0.38;
    for (const t of [0.22, 0.4, 0.58, 0.75]) {
      const x = inner + (outer - inner) * t;
      const len = h * 0.1;
      ctx.beginPath();
      ctx.moveTo(x, lowerY);
      ctx.quadraticCurveTo(
        x + dir * len * 0.2,
        lowerY + len * 0.7,
        x + dir * len * 0.15,
        lowerY + len,
      );
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Paint one frame. `ctx` must already be transformed so that 1 unit = 1 rig px.
 */
export function drawRig(
  ctx: CanvasRenderingContext2D,
  rig: RigManifest,
  imgs: RigImages,
  pose: RigPose,
): void {
  const A = rig.anchors;
  const L = rig.layers;
  const P = rig.pivots ?? {};
  const layer = (name: string, alpha = 1) => {
    const img = imgs.get(name);
    const off = L[name];
    if (!img || !off || alpha <= 0.003) return;
    const prev = ctx.globalAlpha;
    if (alpha < 1) ctx.globalAlpha = prev * alpha;
    const k = off[2] ?? 1;
    if (k === 1) ctx.drawImage(img, off[0], off[1]);
    else ctx.drawImage(img, off[0], off[1], img.width * k, img.height * k);
    ctx.globalAlpha = prev;
  };
  const tint = pose.tint;
  const tintedLayer = (name: string, slot: number) => {
    const img = imgs.get(name);
    const off = L[name];
    if (!img || !off) return;
    if (tint.a <= 0.004) return layer(name);
    const c = scratchCanvas(img.width, img.height, slot);
    const g = c.getContext('2d') as CanvasRenderingContext2D | null;
    if (!g) return layer(name);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = `rgba(${tint.r | 0},${tint.g | 0},${tint.b | 0},${tint.a})`;
    g.fillRect(0, 0, c.width, c.height);
    const k = off[2] ?? 1;
    ctx.drawImage(c as CanvasImageSource, off[0], off[1], img.width * k, img.height * k);
  };
  const pivot = (p: [number, number], fn: () => void, rot = 0, sx = 1, sy = 1) => {
    ctx.save();
    ctx.translate(p[0], p[1]);
    if (rot) ctx.rotate(rot);
    if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
    ctx.translate(-p[0], -p[1]);
    fn();
    ctx.restore();
  };
  /** white + iris hard-clipped to the eye-white alpha (and a tight oval) at native res */
  const composeEye = (side: 'l' | 'r') => {
    const white = imgs.get(`eye-white-${side}`);
    const wo = L[`eye-white-${side}`];
    if (!white || !wo) return null;
    const k = wo[2] ?? 1;
    const c = scratchCanvas(white.width, white.height, side === 'l' ? 2 : 3);
    const g = c.getContext('2d') as CanvasRenderingContext2D | null;
    if (!g) return null;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(white, 0, 0);
    const iris = imgs.get(`iris-${side}`);
    const io = L[`iris-${side}`];
    const r = rig.irisRadius?.[side] ?? 20;
    if (iris && io) {
      g.globalCompositeOperation = 'source-atop';
      const dx = (io[0] - wo[0]) / k + (pose.irisX * r * 0.34) / k;
      const dy = (io[1] - wo[1]) / k + (pose.irisY * r * 0.16) / k;
      // draw iris ~4% larger so soft/AA rim never leaves a white gap at the lid
      const is = 1.04;
      const iw = iris.width * is;
      const ih = iris.height * is;
      g.drawImage(iris, dx - (iw - iris.width) / 2, dy - (ih - iris.height) / 2, iw, ih);
    }
    // belt-and-suspenders: hard oval clip matching the open-eye shape under the lash
    const m = rig.eyes?.[side];
    if (m) {
      const ox0 = m.ovalX0 ?? m.x0;
      const ox1 = m.ovalX1 ?? m.x1;
      const oy0 = m.ovalTop ?? m.top;
      const oy1 = m.ovalBottom ?? m.bottom;
      const cx = (ox0 + ox1) / 2;
      const cy = (oy0 + oy1) / 2;
      const rx = ((ox1 - ox0) / 2) * 1.04;
      const ry = ((oy1 - oy0) / 2) * 1.08;
      g.globalCompositeOperation = 'destination-in';
      g.beginPath();
      g.ellipse((cx - wo[0]) / k, (cy - wo[1]) / k, rx / k, ry / k, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    return { c, wo, k, white };
  };
  /** legacy rigs: squash the eye group for blinks */
  const squashEye = (side: 'l' | 'r', pivotPt: [number, number]) => {
    const e = composeEye(side);
    if (!e) return false;
    pivot(
      pivotPt,
      () => {
        ctx.drawImage(
          e.c as CanvasImageSource,
          e.wo[0],
          e.wo[1],
          e.white.width * e.k,
          e.white.height * e.k,
        );
        layer(`lash-${side}`);
      },
      0,
      pose.eyeScale,
      pose.eyeOpen * pose.eyeScale,
    );
    return true;
  };
  /** upper lid descends over the eye (iris clipped, never squashed); procedural closed / ^^ */
  const lidEye = (side: 'l' | 'r', m: Eye) => {
    const color = rig.lashColor ?? '#3a2218';
    const h = m.bottom - m.top;
    const w = m.x1 - m.x0;
    const cx = (m.x0 + m.x1) / 2;
    const cy = (m.top + m.bottom) / 2;
    const irisC = (side === 'l' ? A.irisL : A.irisR) ?? [cx, cy];
    const closeY = m.top + h * 0.66;
    const em = side === 'l' ? pose.eyeL : pose.eyeR;
    const cl = clamp01(em ? em.cl : pose.lidClose);
    const happyA = smooth(0.2, 0.8, em ? em.happy : pose.happy);
    const openA = 1 - happyA;
    const slope = em ? em.slope : 0;
    const eScale = em ? em.scale : pose.eyeScale;
    const lidAlphaV = em ? em.lidAlpha : pose.lidAlpha;
    const x0 = m.x0 - w * 0.25;
    const x1 = m.x1 + w * 0.25;
    const edge = m.top - 2 + (closeY - m.top + 2) * cl;
    const edgeAt = (x: number) => {
      const t = clamp01((x - m.x0) / w);
      const outerT = side === 'r' ? t : 1 - t;
      return (
        edge -
        h * 0.2 * (1 - cl) * Math.sin(Math.PI * t) +
        h * 0.12 * cl * Math.sin(Math.PI * t) +
        slope * h * 0.7 * (outerT - 0.5)
      );
    };
    const edgePath = () => {
      for (let i = 0; i <= 12; i++) {
        const x = x0 + ((x1 - x0) * i) / 12;
        ctx.lineTo(x, edgeAt(x));
      }
    };
    pivot(
      [cx, cy],
      () => {
        if (openA > 0.01 && cl < 0.985) {
          const e = composeEye(side);
          ctx.save();
          ctx.globalAlpha *= openA;
          if (e) {
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x0, m.bottom + 30);
            edgePath();
            ctx.lineTo(x1, m.bottom + 30);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(
              e.c as CanvasImageSource,
              e.wo[0],
              e.wo[1],
              e.white.width * e.k,
              e.white.height * e.k,
            );
            ctx.restore();
          }
          // lower lash stays; upper lash rides the lid down and fades into the closed line
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0 - 20, irisC[1], x1 - x0 + 40, h + 40);
          ctx.clip();
          layer(`lash-${side}`, 1 - smooth(0.55, 0.9, cl));
          ctx.restore();
          const lashA = 1 - smooth(0.62, 0.95, cl);
          if (lashA > 0.01) {
            ctx.save();
            ctx.globalAlpha *= lashA;
            ctx.translate(0, edge - (m.top - 2));
            ctx.beginPath();
            ctx.rect(x0 - 20, m.top - 60, x1 - x0 + 40, irisC[1] - m.top + 60);
            ctx.clip();
            pivot([cx, m.top], () => layer(`lash-${side}`), 0, 1, 1 - 0.35 * cl);
            ctx.restore();
          }
          ctx.restore();
        }
        // lid mound: soft warm fill so closed/happy lids are not pale flat inpaint
        const lidFill = Math.max(smooth(0.25, 1, cl), happyA * 0.85);
        if (lidFill > 0.01) {
          const sy = closeY * (1 - happyA) + (m.top + h * 0.42) * happyA;
          const gr = ctx.createRadialGradient(cx, sy - h * 0.05, w * 0.08, cx, sy, w * 0.72);
          gr.addColorStop(0, `rgba(236, 176, 156, ${0.55 * lidFill})`);
          gr.addColorStop(0.45, `rgba(220, 150, 130, ${0.32 * lidFill})`);
          gr.addColorStop(1, 'rgba(210, 140, 120, 0)');
          ctx.fillStyle = gr;
          ctx.beginPath();
          ctx.ellipse(cx, sy, w * 0.7, h * 0.5, 0, 0, Math.PI * 2);
          ctx.fill();
          // cooler shadow tucked under the brow / upper crease
          const sh = ctx.createRadialGradient(
            cx,
            m.top + h * 0.1,
            0,
            cx,
            m.top + h * 0.15,
            w * 0.55,
          );
          sh.addColorStop(0, `rgba(180, 110, 95, ${0.22 * lidFill})`);
          sh.addColorStop(1, 'rgba(180, 110, 95, 0)');
          ctx.fillStyle = sh;
          ctx.beginPath();
          ctx.ellipse(cx, m.top + h * 0.18, w * 0.55, h * 0.28, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        lidStroke(ctx, m, side, closeY, 'closed', color, lidAlphaV * openA);
        lidStroke(ctx, m, side, m.top + h * 0.58, 'happy', color, happyA);
      },
      0,
      eScale,
      eScale,
    );
  };

  const [W, H] = rig.size;
  const neck = A.neck;
  ctx.save();
  ctx.translate(W / 2, H);
  ctx.scale(pose.figureScale, pose.figureScale);
  ctx.rotate(pose.torsoRot);
  ctx.translate(-W / 2 + pose.torsoX, -H + pose.bodyY);

  // torso breathes from the bottom edge; arms ride the shoulders; badge / strap swing
  const ex = pose.ext?.v;
  const rOn = ex ? ex[IDX.rOn] : 0;
  const lOn = ex ? ex[IDX.lOn] : 0;
  const warp = (rOn > 0.001 || lOn > 0.001) && imgs.has('body-noarm');
  pivot([W / 2, H], () => layer(warp ? 'body-noarm' : 'body'), 0, 1, pose.bodyScaleY);
  const part = (name: string, rot: number, lift = 0, alpha = 1) => {
    const pv = P[name];
    if (!pv || !imgs.has(name)) return;
    ctx.save();
    ctx.translate(0, lift);
    pivot(pv, () => layer(name, alpha), rot);
    ctx.restore();
  };
  /** one arm: rest-arm stump seals body-noarm; mesh strip + hand while posed */
  // both hands are the prayer shape: one joined piece at the chest centre, two sleeves converge
  const prayerPair =
    !!ex &&
    (ex[IDX.lHand] | 0) === (ex[IDX.rHand] | 0) &&
    HAND_NAMES[ex[IDX.rHand] | 0] === 'prayer' &&
    ex[IDX.lOn] > 0.5 &&
    ex[IDX.rOn] > 0.5;
  const jointArms: {
    fx: number;
    fy: number;
    fpsi: number;
    himg: RigImageSource;
    meta: HandPieceMeta;
    sgn: number;
    hs: number;
  }[] = [];
  const drawArm = (side: 'l' | 'r') => {
    const name = side === 'l' ? 'arm-l' : 'arm-r';
    const on = side === 'l' ? lOn : rOn;
    const rot = side === 'l' ? pose.armRotL : pose.armRotR;
    const lift = side === 'l' ? pose.shoulderL : pose.shoulderR;
    const geom = rig.arms?.[side];
    const img = imgs.get(name);
    const pv = P[name];
    const off = L[name];
    if (on <= 0.001 || !ex || !geom || !img || !pv || !off) {
      // While the other arm is posed the torso is the sleeve-free body: keep the idle arm
      // exactly seated on it (no sway/lift) so no background sliver opens at the shoulder seam.
      if (warp) {
        const bImg = imgs.get('body');
        const nImg = imgs.get('body-noarm');
        const bOff = L['body'] ?? L['body-noarm'];
        const fillSide = bImg && nImg && bOff ? bodySideFill(bImg, nImg, side) : null;
        if (fillSide && bOff) ctx.drawImage(fillSide, bOff[0], bOff[1]);
        part(name, 0, 0);
      } else part(name, rot, lift);
      return;
    }
    const sgn = geom.sgn;
    const hand = ex[side === 'l' ? IDX.lHand : IDX.rHand] | 0;
    const hn = HAND_NAMES[hand];
    const joint = hn === 'prayer' && prayerPair;
    const meta = hn ? rig.hands?.[hn] : undefined;
    const himg = hn ? imgs.get(`hand-${hn}`) : undefined;
    const ia = side === 'l' ? IDX.lA : IDX.rA;
    // Full rest arm with distal fade — seals the entire body-noarm hole without a
    // second hanging sleeve (fade kills the cuff). Mesh draws the posed limb on top.
    {
      // seal the upper-arm void between the stump and the sleeve-free torso (no see-through seam)
      const bImg = imgs.get('body');
      const nImg = imgs.get('body-noarm');
      const bOff = L['body'] ?? L['body-noarm'];
      if (bImg && nImg && bOff) {
        // a strongly swung arm leaves only the shoulder cap behind (no ghost of the rest sleeve)
        const swing = Math.min(1, Math.max(0, (Math.abs(ex[ia] * DEG) - 0.35) / 0.5));
        const fillR = Math.round((240 - 130 * swing) / 20) * 20;
        const f = bodySideFill(bImg, nImg, side, [pv[0] - bOff[0], pv[1] - bOff[1]], fillR);
        if (f) {
          ctx.save();
          ctx.translate(0, lift * 0.5);
          ctx.drawImage(f, bOff[0], bOff[1]);
          ctx.restore();
        }
      }
    }
    const stump = shoulderPlug(img, geom);
    if (stump) {
      ctx.save();
      ctx.translate(0, lift);
      ctx.drawImage(stump as CanvasImageSource, off[0], off[1]);
      ctx.restore();
    } else {
      part(name, rot, lift);
    }
    // Wrist gently follows elbow so flaps read as a forearm, not a hinged PNG.
    const elbow = ex[ia + 1] * DEG;
    const wrist = ex[ia + 2] * DEG + elbow * 0.12;
    const hasHand = !!(meta && himg);
    const cuffW = Math.abs(geom.nmax - geom.nmin);
    const hs = hasHand ? handScaleFor(meta!, cuffW) : 0;
    const armP = {
      a: ex[ia] * DEG - sgn * rot,
      e: elbow,
      w: wrist,
      lift,
      handAlpha: 1,
      fore: hn === 'prayer' ? -1 : ex[side === 'l' ? IDX.lF : IDX.rF],
      // taper the sleeve to the hand piece's sleeve and fold the wrist into the forearm so
      // sleeve + cuff are one continuous cloth (no overhanging faded stub)
      endW: hasHand ? hs * meta!.sleeveW * (joint ? 0.95 : 1.12) : undefined,
      mergeMax: joint ? 1.3 : undefined,
      hardEnd: joint,
    };
    const geomArgs = [img, geom, pv, off as [number, number]] as const;
    if (hasHand && joint) {
      // bilateral prayer: both sleeves rise to the chest centre; the single prayer piece is
      // drawn once at their joint after both arms (see armsPass)
      drawArmPieces(ctx, ...geomArgs, armP, ARM_HAND_S + 4);
      jointArms.push({
        fx: armFrame.hx,
        fy: armFrame.hy,
        fpsi: armFrame.hPsi,
        himg: himg!,
        meta: meta!,
        sgn,
        hs,
      });
    } else if (hasHand) {
      // mesh, then the hand piece on top of it, then the sleeve end re-drawn over the piece's
      // sleeve stub: it tapers to the stub's width and dissolves into it (cloth over cloth, no
      // semi-transparent edge ever meets the background)
      drawArmPieces(ctx, ...geomArgs, armP, ARM_HAND_S + 4);
      drawHandPiece(ctx, himg!, meta!, sgn, 1, hs);
      drawArmPieces(ctx, ...geomArgs, { ...armP, fromS: ARM_HAND_S - 60 }, ARM_HAND_S + 4);
    } else {
      drawArmPieces(ctx, ...geomArgs, armP, 1e9);
    }
  };
  const armsPass = () => {
    // Fill the armpit notch that neither arm layer covers (body opaque ∩ body-noarm empty).
    if (warp && imgs.has('body') && imgs.has('body-noarm')) {
      const bodyImg = imgs.get('body');
      const noarmImg = imgs.get('body-noarm');
      const bodyOff = L['body'] ?? L['body-noarm'];
      const shoulder = P['arm-r'] ?? P['arm-l'];
      if (bodyImg && noarmImg && bodyOff && shoulder) {
        const fill = bodyShoulderFill(bodyImg, noarmImg, bodyOff as [number, number], shoulder);
        if (fill) {
          ctx.save();
          ctx.drawImage(fill as CanvasImageSource, bodyOff[0], bodyOff[1]);
          ctx.restore();
        }
      }
    }
    jointArms.length = 0;
    drawArm('l');
    drawArm('r');
    if (jointArms.length === 2) {
      const [a, b] = jointArms;
      const saved = { hx: armFrame.hx, hy: armFrame.hy, hPsi: armFrame.hPsi };
      armFrame.hx = (a.fx + b.fx) / 2;
      armFrame.hy = (a.fy + b.fy) / 2;
      const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
      armFrame.hPsi = (wrap(a.fpsi) + wrap(b.fpsi)) / 2;
      drawHandPiece(ctx, a.himg, a.meta, 1, 1, (a.hs + b.hs) / 2, 40);
      armFrame.hx = saved.hx;
      armFrame.hy = saved.hy;
      armFrame.hPsi = saved.hPsi;
    }
  };
  part('badge', pose.badgeRot);
  const armFront = !!ex && ex[IDX.armFront] > 0.5 && warp;
  if (!armFront) armsPass();
  part('strap-r', pose.strapRot, pose.shoulderR * 0.5, 1 - smooth(0, 0.4, rOn));

  const neckLift = (H - neck[1]) * (pose.bodyScaleY - 1);
  ctx.save();
  ctx.translate(pose.headX, pose.headY - neckLift);
  ctx.translate(neck[0], neck[1]);
  ctx.rotate(pose.headRot);
  ctx.translate(-neck[0], -neck[1]);

  // tint only the head's own pixels (source-atop on scratch canvases)
  tintedLayer('head', 0);
  tintedLayer('crown', 5);
  tintedLayer('face-hd', 1);

  // blush (soft radial gradients on the cheeks; smile soft-squash widens them)
  if (pose.blush > 0.02 && A.cheekL && A.cheekR) {
    const sq = 1 + 0.22 * (pose.cheekSquash ?? 0);
    const rx = 26 * sq;
    const ry = 16 * (2 - sq); // slight vertical squash
    for (const c of [A.cheekL, A.cheekR]) {
      const gr = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], rx);
      gr.addColorStop(0, `rgba(255,120,120,${0.4 * pose.blush})`);
      gr.addColorStop(1, 'rgba(255,120,120,0)');
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.ellipse(c[0], c[1] + 1.5 * (pose.cheekSquash ?? 0), rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // features ride a little further than the head → parallax depth
  ctx.save();
  ctx.translate(pose.featX, pose.featY);
  const hd = imgs.has('eye-white-l');
  if (hd && rig.eyes?.l && rig.eyes?.r) {
    lidEye('l', rig.eyes.l);
    lidEye('r', rig.eyes.r);
  } else if (pose.eyeVariant === 'happy') {
    if (hd) {
      layer('happy-l');
      layer('happy-r');
    } else layer('eyes-happy');
  } else {
    if (pose.eyeOpen > 0.06) {
      if (!squashEye('l', A.eyeL))
        pivot(A.eyeL, () => layer('eye-l'), 0, pose.eyeScale, pose.eyeOpen * pose.eyeScale);
      if (!squashEye('r', A.eyeR))
        pivot(A.eyeR, () => layer('eye-r'), 0, pose.eyeScale, pose.eyeOpen * pose.eyeScale);
    }
    if (hd) {
      layer('lid-l', pose.lidAlpha);
      layer('lid-r', pose.lidAlpha);
    } else layer('eyes-closed', pose.lidAlpha);
  }
  const mCode = ex && pose.mouthVariant === 'closed' ? ex[IDX.mouth] | 0 : 0;
  if (mCode >= 6 || mCode === 2 || (mCode === 3 && pose.mouthOpen < 0.06)) {
    // action mouths: strokes in the artwork's mouth colour, or the master 'open' plate for 3
    if (mCode === 3) {
      pivot(A.mouth, () => layer('mouth-open'), 0, 1, 0.9);
    } else if (mCode === 2) {
      pivot(A.mouth, () => layer('mouth'), 0, 1.14, 1.15);
    } else {
      drawMouth(ctx, mCode, A.mouth[0], A.mouth[1], 0.6);
    }
  } else if (mCode === 4 && pose.mouthOpen < 0.06) {
    pivot(A.mouth, () => layer('mouth-o'), 0, 0.8, 0.8);
  } else if (
    pose.mouthVariant === 'closed' ||
    pose.mouthVariant === 'frown' ||
    mCode === 5 ||
    mCode === 1
  ) {
    layer(pose.mouthVariant === 'frown' || mCode === 5 ? 'mouth-frown' : 'mouth');
  } else {
    const name = pose.mouthVariant === 'o' ? 'mouth-o' : 'mouth-open';
    const open = 0.35 + 0.65 * pose.mouthOpen;
    const wv = pose.mouthWidth ?? 1;
    pivot(
      A.mouth,
      () => layer(name),
      0,
      (pose.mouthVariant === 'o' ? 0.5 + 0.1 * open : 0.85 + 0.15 * open) * wv,
      open * (2 - wv) ** 0.5,
    );
  }
  ctx.restore();

  // fringe stays rigid with the head (brand-lock); micro brow-raise only. Side/ribbon share
  // one spring so the silhouette still reads as one continuous head of hair.
  ctx.save();
  ctx.translate(0, -1.0 * (pose.browRaise ?? 0));
  tintedLayer('bangs', 4);
  ctx.restore();
  // brow strokes (only while an action asks for them) read through the fringe
  if ((pose.browAlpha ?? 0) > 0.02 && rig.eyes?.l && rig.eyes?.r) {
    ctx.save();
    ctx.translate(pose.featX, pose.featY);
    drawBrow(
      ctx,
      pose.browKind ?? 0,
      rig.eyes.l.x0,
      rig.eyes.l.x1,
      rig.eyes.l.top,
      1,
      pose.browAlpha ?? 0,
    );
    drawBrow(
      ctx,
      pose.browKind ?? 0,
      rig.eyes.r.x0,
      rig.eyes.r.x1,
      rig.eyes.r.top,
      -1,
      pose.browAlpha ?? 0,
    );
    ctx.restore();
  }
  // official N hair clip rides on top of the fringe (brand part, never deformed)
  layer('clip');
  // secondary motion layers (hang from their roots)
  if (A.hairL) pivot(A.hairL, () => layer('hair-side-l'), pose.hairRotL);
  if (A.hairR) pivot(A.hairR, () => layer('hair-side-r'), pose.hairRotR);
  if (A.ribbon) pivot(A.ribbon, () => layer('ribbon'), pose.ribbonRot);
  layer('earring');

  if (ex && A.headTop && A.eyeL && A.eyeR && A.cheekL && A.cheekR) {
    drawFx(ctx, A.headTop, A.eyeL, A.eyeR, A.cheekL, A.cheekR, ex, pose.time ?? 0, !!pose.reduced);
  }
  // little manga marks
  if (pose.angerMark > 0.05 && A.headTop) {
    const [x, y] = [A.headTop[0] + 120, A.headTop[1] + 40];
    ctx.save();
    ctx.globalAlpha = pose.angerMark;
    ctx.strokeStyle = '#e8432f';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    for (const [dx, dy] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ] as const) {
      const ang = Math.atan2(-dy, -dx);
      ctx.beginPath();
      ctx.arc(x + dx * 16, y + dy * 16, 10, ang - Math.PI / 2, ang + Math.PI / 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  if (pose.sweat > 0.05 && A.headTop) {
    const [x, y] = [A.headTop[0] - 140, A.headTop[1] + 120];
    ctx.save();
    ctx.globalAlpha = pose.sweat * 0.85;
    ctx.fillStyle = '#8fd0ff';
    ctx.strokeStyle = '#3d7fb8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y - 22);
    ctx.quadraticCurveTo(x + 14, y, x, y + 10);
    ctx.quadraticCurveTo(x - 14, y, x, y - 22);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  if (armFront) armsPass();
  ctx.restore();
}

/**
 * Bust framing used by the mascot window: rig scaled to the canvas (w × h CSS px) with a
 * little headroom, plus a soft fade at the bottom edge so the cut-off waist never ends hard.
 */
/** Where the rig is drawn inside the canvas: rig px → CSS px is `x * sc + ox`. */
export interface RigView {
  sc: number;
  ox: number;
  oy: number;
}

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fit the rig into a character box (defaults to the whole canvas). */
export function rigTransform(rig: RigManifest, w: number, h: number, box?: ViewBox): RigView {
  const b = box ?? { x: 0, y: 0, w, h };
  const [rw, rh] = rig.size;
  const sc = Math.min((b.w * 0.98) / rw, b.h / (rh * 0.95));
  // bottom-anchored (identical to the old top offset rh·0.025·sc when height-limited)
  return { sc, ox: b.x + (b.w - rw * sc) / 2, oy: b.y + b.h - rh * sc * 0.925 };
}

type RigRect = { left: number; top: number; right: number; bottom: number };

/** Rig-space rect of a layer (from its offset, draw scale and the loaded image size). */
export function rigLayerRect(rig: RigManifest, imgs: RigImages, name: string): RigRect | null {
  const off = rig.layers[name];
  const img = imgs.get(name);
  if (!off || !img) return null;
  const s = off[2] ?? 1;
  const iw = (img as { naturalWidth?: number }).naturalWidth || img.width;
  const ih = (img as { naturalHeight?: number }).naturalHeight || img.height;
  return { left: off[0], top: off[1], right: off[0] + iw * s, bottom: off[1] + ih * s };
}

const union = (rects: Array<RigRect | null>): RigRect | null => {
  const r = rects.filter((x): x is RigRect => !!x);
  if (!r.length) return null;
  return {
    left: Math.min(...r.map((x) => x.left)),
    top: Math.min(...r.map((x) => x.top)),
    right: Math.max(...r.map((x) => x.right)),
    bottom: Math.max(...r.map((x) => x.bottom)),
  };
};

const HEAD_LAYERS = ['head', 'crown', 'bangs', 'hair-side-l', 'hair-side-r', 'ribbon'];
const BODY_LAYERS = ['body', 'arm-l', 'arm-r', ...HEAD_LAYERS];

/**
 * Head (face + hair) rect in canvas CSS px for the current pose, padded by `pad` (fraction of
 * its width) to cover sway / tilt. Used by the speech bubble to never cover the face.
 */
export function rigHeadBox(
  rig: RigManifest,
  imgs: RigImages,
  pose: Pick<RigPose, 'headX' | 'headY' | 'bodyY' | 'torsoX' | 'figureScale'> | null,
  view: RigView,
  pad = 0.08,
): RigRect | null {
  const r = union(HEAD_LAYERS.map((n) => rigLayerRect(rig, imgs, n)));
  if (!r) return null;
  const [W, H] = rig.size;
  const fs = pose?.figureScale ?? 1;
  const dx = (pose?.headX ?? 0) + (pose?.torsoX ?? 0);
  const dy = (pose?.headY ?? 0) + (pose?.bodyY ?? 0);
  // figureScale scales about the bottom centre of the rig
  const fx = (x: number) => W / 2 + (x + dx - W / 2) * fs;
  const fy = (y: number) => H + (y + dy - H) * fs;
  const p = (r.right - r.left) * pad;
  return {
    left: (fx(r.left) - p) * view.sc + view.ox,
    right: (fx(r.right) + p) * view.sc + view.ox,
    top: (fy(r.top) - p) * view.sc + view.oy,
    bottom: (fy(r.bottom) + p) * view.sc + view.oy,
  };
}

/** Whole-figure rect (canvas CSS px), clamped to the canvas. */
export function rigBodyBox(
  rig: RigManifest,
  imgs: RigImages,
  view: RigView,
  w: number,
  h: number,
): RigRect | null {
  const r = union(BODY_LAYERS.map((n) => rigLayerRect(rig, imgs, n)));
  if (!r) return null;
  return {
    left: Math.max(0, r.left * view.sc + view.ox),
    right: Math.min(w, r.right * view.sc + view.ox),
    top: Math.max(0, r.top * view.sc + view.oy),
    bottom: Math.min(h, r.bottom * view.sc + view.oy),
  };
}

export function paintRigFrame(
  ctx: CanvasRenderingContext2D,
  rig: RigManifest,
  imgs: RigImages,
  pose: RigPose,
  w: number,
  h: number,
  box?: ViewBox,
): void {
  const v = rigTransform(rig, w, h, box);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  ctx.translate(v.ox, v.oy);
  ctx.scale(v.sc, v.sc);
  drawRig(ctx, rig, imgs, pose);
  ctx.restore();
  const fadeH = (box?.h ?? h) * 0.12;
  const g = ctx.createLinearGradient(0, h - fadeH, 0, h);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = g;
  ctx.fillRect(0, h - fadeH, w, fadeH);
  ctx.globalCompositeOperation = 'source-over';
}
