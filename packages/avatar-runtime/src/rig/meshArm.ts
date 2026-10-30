/**
 * Mesh-warped arm for the Nomi 2D rig (Canvas2D only).
 *
 * The master arm layer (the sleeve cut from the approved artwork) is re-drawn as a strip of
 * triangles that follow a bendable spine: the shoulder rotates the whole strip, the elbow bends it
 * smoothly (inner side folds, outer side stretches). A hand piece is attached at the strip end with a
 * feathered seam. Nothing here generates art: every pixel comes from the master sleeve or the hand
 * pieces. When no gesture is active the animator draws the untouched master arm layer instead.
 */

import type { RigImageSource } from './rigTypes';

export interface ArmGeom {
  layer: string;
  /** +1 right arm (outward = +x), −1 left arm */
  sgn: 1 | -1;
  /** spine tilt from vertical (rad, magnitude) */
  theta: number;
  /** spine origin in layer-local px */
  s0: [number, number];
  smin: number;
  smax: number;
  nmin: number;
  nmax: number;
}

export interface HandPieceMeta {
  file: string;
  w: number;
  h: number;
  /** attach point (bottom centre of the sleeve) in piece px */
  ax: number;
  ay: number;
  sleeveW: number;
  cuffY: number;
  /** optional size multiplier applied after the cuff-width fit (default 1) */
  k?: number;
}

export interface ArmDrawParams {
  /** shoulder lift outward/up (rad) incl. idle sway */
  a: number;
  /** elbow bend (rad) */
  e: number;
  /** wrist twist (rad) */
  w: number;
  /** shoulder vertical lift (rig px, from breathing) */
  lift: number;
  /** hand piece alpha 0..1 */
  handAlpha: number;
  /** ignored (compat) */
  fore?: number;
  /**
   * Target sleeve width (rig px) at the wrist. When set the mesh tapers to it and the wrist
   * bend is folded into the forearm itself, so the sleeve is one continuous cloth that ends
   * exactly under the hand piece's sleeve (no rigid rotated stub, no soft fade needed).
   */
  endW?: number;
  /** with endW: bend the forearm so the hand frame ends at exactly this angle (rad) */
  wristTo?: number;
  /** compute the hand frame only (no pixels) so the hand piece can be drawn first */
  dry?: boolean;
  /** draw only the mesh rows beyond this s (re-draw the sleeve end over the hand piece) */
  fromS?: number;
  /** max wrist angle (rad) folded into the sleeve (default ARM_WRIST_MERGE) */
  mergeMax?: number;
  /** merged mode without the dissolve: the sleeve end is cut hard and tucked under the piece */
  hardEnd?: boolean;
}

/** Spine arc-length of the shoulder joint, the elbow, and where the hand piece attaches. */
export const ARM_ELBOW_S = 335;
export const ARM_BEND_LEN = 120;
export const ARM_HAND_S = 470;
export const HAND_SCALE = 0.42;
/** s where the sleeve taper starts / has finished (merged wrist mode) */
export const ARM_TAPER_S0 = 300;
export const ARM_TAPER_S1 = ARM_HAND_S - 30;
/** merged mode: the mesh dissolves into the hand piece's sleeve over this s range */
/** max wrist angle (rad) folded into the sleeve itself in merged mode */
/** elbow bend limit (rad) */
export const ARM_BEND_MAX = 2.4;
export const ARM_WRIST_MERGE = 0.6;
export const ARM_DISSOLVE_S0 = ARM_HAND_S - 12;

const MAX_ROWS = 40;
const COLS = 6;
const rowS = new Float64Array(MAX_ROWS);
const rowPx = new Float64Array(MAX_ROWS);
const rowPy = new Float64Array(MAX_ROWS);
const rowPhi = new Float64Array(MAX_ROWS);
const rowK = new Float64Array(MAX_ROWS);
const dstX = new Float64Array(MAX_ROWS * (COLS + 1));
const dstY = new Float64Array(MAX_ROWS * (COLS + 1));
const srcX = new Float64Array(MAX_ROWS * (COLS + 1));
const srcY = new Float64Array(MAX_ROWS * (COLS + 1));

const smooth01 = (x: number) => {
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  return c * c * (3 - 2 * c);
};

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Draw one source triangle mapped onto a destination triangle (affine), slightly expanded to hide seams. */
function tri(
  ctx: Ctx,
  img: RigImageSource,
  sx0: number,
  sy0: number,
  sx1: number,
  sy1: number,
  sx2: number,
  sy2: number,
  dx0: number,
  dy0: number,
  dx1: number,
  dy1: number,
  dx2: number,
  dy2: number,
): void {
  const det = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);
  if (Math.abs(det) < 1e-6) return;
  const a = ((dx1 - dx0) * (sy2 - sy0) - (dx2 - dx0) * (sy1 - sy0)) / det;
  const b = ((dy1 - dy0) * (sy2 - sy0) - (dy2 - dy0) * (sy1 - sy0)) / det;
  const c = ((dx2 - dx0) * (sx1 - sx0) - (dx1 - dx0) * (sx2 - sx0)) / det;
  const d = ((dy2 - dy0) * (sx1 - sx0) - (dy1 - dy0) * (sx2 - sx0)) / det;
  const e = dx0 - a * sx0 - c * sy0;
  const f = dy0 - b * sx0 - d * sy0;
  // expand the clip triangle ~0.6px from its centroid so neighbours overlap (no hairline gaps)
  const cx = (dx0 + dx1 + dx2) / 3;
  const cy = (dy0 + dy1 + dy2) / 3;
  const ex = (x: number, y: number, out: number[]) => {
    const vx = x - cx;
    const vy = y - cy;
    const l = Math.hypot(vx, vy) || 1;
    out[0] = x + (vx / l) * 0.7;
    out[1] = y + (vy / l) * 0.7;
  };
  ex(dx0, dy0, T0);
  ex(dx1, dy1, T1);
  ex(dx2, dy2, T2);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(T0[0], T0[1]);
  ctx.lineTo(T1[0], T1[1]);
  ctx.lineTo(T2[0], T2[1]);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}
const T0 = [0, 0];
const T1 = [0, 0];
const T2 = [0, 0];

interface ArmProfile {
  step: number;
  s0: number;
  /** silhouette width / centre (arm-layer n units) per s sample */
  w: Float32Array;
  c: Float32Array;
}
const profCache = new WeakMap<object, ArmProfile | null>();

/** Real sleeve silhouette (lateral extent of opaque pixels) along the arm axis. Cached per arm image. */
function armProfile(img: RigImageSource, g: ArmGeom): ArmProfile | null {
  const hit = profCache.get(img as object);
  if (hit !== undefined) return hit;
  let out: ArmProfile | null;
  try {
    const iw = (img as { width: number }).width;
    const ih = (img as { height: number }).height;
    const cv =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(iw, ih)
        : Object.assign(document.createElement('canvas'), { width: iw, height: ih });
    const cx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    cx.drawImage(img as CanvasImageSource, 0, 0);
    const d = cx.getImageData(0, 0, iw, ih).data;
    const sinT = Math.sin(g.theta);
    const cosT = Math.cos(g.theta);
    const ux = g.sgn * sinT;
    const uy = cosT;
    const wx = cosT;
    const wy = -g.sgn * sinT;
    const step = 6;
    const s0 = Math.floor(g.smin);
    const cnt = Math.ceil((g.smax - s0) / step) + 1;
    const w = new Float32Array(cnt);
    const c = new Float32Array(cnt);
    const mid = (g.nmin + g.nmax) / 2;
    const full = Math.abs(g.nmax - g.nmin);
    for (let i = 0; i < cnt; i++) {
      const s = s0 + i * step;
      let lo = 1e9;
      let hi = -1e9;
      for (let n = g.nmin - 20; n <= g.nmax + 20; n += 1.5) {
        const x = Math.round(g.s0[0] + s * ux + n * wx);
        const y = Math.round(g.s0[1] + s * uy + n * wy);
        if (x < 0 || y < 0 || x >= iw || y >= ih) continue;
        if (d[(y * iw + x) * 4 + 3] > 110) {
          if (n < lo) lo = n;
          if (n > hi) hi = n;
        }
      }
      if (hi > lo + 20) {
        w[i] = hi - lo;
        c[i] = (hi + lo) / 2;
      } else {
        w[i] = full;
        c[i] = mid;
      }
    }
    out = { step, s0, w, c };
  } catch {
    out = null;
  }
  profCache.set(img as object, out);
  return out;
}
const profAt = (pr: ArmProfile, arr: Float32Array, s: number): number => {
  const f = Math.max(0, Math.min(arr.length - 1.001, (s - pr.s0) / pr.step));
  const i = Math.floor(f);
  return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
};

export interface ArmFrame {
  /** hand attach point (rig px), direction of the forearm (rad, canvas rotation from straight down) */
  hx: number;
  hy: number;
  hPsi: number;
}
export const armFrame: ArmFrame & { fore: number } = { hx: 0, hy: 0, hPsi: 0, fore: 1 };

/**
 * Build rows + draw the strip. `pivot` is the shoulder pivot and `off` the layer offset, both in rig px.
 * Returns the hand frame via the shared `armFrame` object.
 */
export function drawArmStrip(
  ctx: Ctx,
  img: RigImageSource,
  g: ArmGeom,
  pivot: readonly [number, number],
  off: readonly [number, number],
  p: ArmDrawParams,
  sEnd: number,
): void {
  const sgn = g.sgn;
  const sinT = Math.sin(g.theta);
  const cosT = Math.cos(g.theta);
  const u0x = sgn * sinT;
  const u0y = cosT;
  const w0x = cosT;
  const w0y = -sgn * sinT;
  // pivot in (s, n)
  const plx = pivot[0] - off[0] - g.s0[0];
  const ply = pivot[1] - off[1] - g.s0[1];
  const sp = plx * u0x + ply * u0y;
  const np = plx * w0x + ply * w0y;

  // rows
  let n = 0;
  const smin = g.smin;
  const se = Math.min(sEnd, g.smax);
  const b0 = ARM_ELBOW_S - ARM_BEND_LEN / 2;
  const b1 = ARM_ELBOW_S + ARM_BEND_LEN / 2;
  const push = (s: number) => {
    if (n < MAX_ROWS && s > (n ? rowS[n - 1] + 1 : -1e9) && s <= se + 0.001) rowS[n++] = s;
  };
  push(smin);
  for (const s of [60, 120, 180, 230]) if (s > smin && s < b0) push(s);
  for (let s = b0; s <= b1 + 0.1; s += ARM_BEND_LEN / 8) push(s);
  for (let s = b1 + 30; s < (p.endW !== undefined ? ARM_DISSOLVE_S0 - 4 : se - 6); s += 30) push(s);
  if (p.endW !== undefined) for (let s = ARM_DISSOLVE_S0; s < se; s += 4) push(s);
  push(se);

  const bend = Math.max(-ARM_BEND_MAX, Math.min(ARM_BEND_MAX, p.e));
  const absBend = Math.abs(bend);
  const innerSign = sgn * (bend >= 0 ? 1 : -1);
  const sgnRot = -sgn;
  // Raise-driven foreshortening: compress distal length so a lifted cuff stays on-canvas
  // without scaling the shoulder away from the body-noarm hole.
  // fore < 0 switches foreshortening off (arm reaching across the chest, e.g. prayer)
  const raise =
    (p.fore ?? 0) < 0
      ? 0
      : Math.max(
          Math.min(1, Math.abs(p.a) / 0.55),
          Math.min(1, absBend / 1.4) * 0.55,
          Math.min(1, p.fore ?? 0),
        );
  const lenAt = (s: number) => {
    if (s <= b0) return 1;
    const t = smooth01((s - b0) / Math.max(60, ARM_HAND_S - b0));
    return 1 - raise * 0.75 * t;
  };
  // Keep the proximal stump locked to the body-noarm hole; blend shoulder angle in
  // before the elbow so a raise does not open a green wedge at the jacket seam.
  const stump = Math.max(smin + 20, 90);
  const shoulderBlendOf = (s: number) => smooth01((s - stump) / Math.max(40, b0 - stump));
  const merged = p.endW !== undefined;
  const phi0 = (s: number) =>
    sgnRot * (p.a * shoulderBlendOf(s) + bend * smooth01((s - b0) / ARM_BEND_LEN));
  // merged mode: the wrist angle is folded into the last stretch of the forearm
  let wEff = 0;
  let wRest = 0;
  const wS0 = ARM_TAPER_S1 - 110;
  const phiOf = (s: number) =>
    phi0(s) + (merged ? sgnRot * wEff * smooth01((s - wS0) / (ARM_TAPER_S1 - wS0)) : 0);
  // spine integration from the pivot
  const phiP = phiOf(sp);
  const wx = w0x * Math.cos(phiP) - w0y * Math.sin(phiP);
  const wy = w0x * Math.sin(phiP) + w0y * Math.cos(phiP);
  const pxP = pivot[0] - np * wx;
  const pyP = pivot[1] + p.lift - np * wy;
  // find row nearest to sp to anchor; integrate outward in both directions
  const ux = (phi: number) => u0x * Math.cos(phi) - u0y * Math.sin(phi);
  const uy = (phi: number) => u0x * Math.sin(phi) + u0y * Math.cos(phi);
  // integrate with fine steps; distal steps shrink with raise (foreshorten)
  const pos = (s: number, out: number[]) => {
    let x = pxP;
    let y = pyP;
    const dir = s >= sp ? 1 : -1;
    const steps = Math.max(1, Math.ceil(Math.abs(s - sp) / 6));
    const h = (s - sp) / steps;
    for (let i = 0; i < steps; i++) {
      const sm = sp + h * (i + 0.5);
      const ph = phiOf(sm);
      const ls = lenAt(sm);
      x += ux(ph) * h * ls;
      y += uy(ph) * h * ls;
    }
    out[0] = x;
    out[1] = y;
    return dir;
  };
  const tmp = [0, 0];
  if (merged) {
    pos(ARM_HAND_S, tmp);
    const plain = phi0(ARM_HAND_S) - sgn * g.theta + Math.PI + sgnRot * p.w;
    const psiT = p.wristTo ?? keepOnCanvas(tmp[0], tmp[1], plain);
    let d = (psiT - Math.PI + sgn * g.theta - phi0(ARM_HAND_S)) / sgnRot;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    // fold at most ARM_WRIST_MERGE of the wrist angle into the sleeve; the hand piece takes the rest
    const mm = p.mergeMax ?? ARM_WRIST_MERGE;
    wEff = Math.max(-mm, Math.min(mm, d));
    wRest = d - wEff;
  }
  for (let i = 0; i < n; i++) {
    const s = rowS[i];
    pos(s, tmp);
    rowPx[i] = tmp[0];
    rowPy[i] = tmp[1];
    rowPhi[i] = phiOf(s);
    // curvature magnitude (rad / px) of the bend at s
    const x = (s - b0) / ARM_BEND_LEN;
    rowK[i] = x > 0 && x < 1 ? (absBend * 6 * x * (1 - x)) / ARM_BEND_LEN : 0;
  }
  const prof = merged ? armProfile(img, g) : null;
  // mesh vertices
  for (let i = 0; i < n; i++) {
    const phi = rowPhi[i];
    const cw = Math.cos(phi);
    const sw = Math.sin(phi);
    const wx2 = w0x * cw - w0y * sw;
    const wy2 = w0x * sw + w0y * cw;
    for (let j = 0; j <= COLS; j++) {
      const nn = g.nmin + ((g.nmax - g.nmin) * j) / COLS;
      let ne = nn;
      const m = nn * innerSign;
      if (m > 0 && rowK[i] > 0) ne = (m / (1 + m * rowK[i])) * innerSign;
      if (merged) {
        const mt = smooth01((rowS[i] - ARM_TAPER_S0) / (ARM_TAPER_S1 - ARM_TAPER_S0));
        const sw0 = prof ? profAt(prof, prof.w, rowS[i]) : Math.abs(g.nmax - g.nmin);
        const nc = prof ? profAt(prof, prof.c, rowS[i]) : (g.nmin + g.nmax) / 2;
        // squeeze the *real* sleeve silhouette to the hand piece's sleeve width, centred on the spine
        const tau = 1 - (1 - (p.endW as number) / sw0) * mt;
        ne = nc * (1 - mt) + (ne - nc) * tau;
      }
      const k = i * (COLS + 1) + j;
      dstX[k] = rowPx[i] + ne * wx2;
      dstY[k] = rowPy[i] + ne * wy2;
      srcX[k] = g.s0[0] + rowS[i] * u0x + nn * w0x;
      srcY[k] = g.s0[1] + rowS[i] * u0y + nn * w0y;
    }
  }
  if (!p.dry)
    for (let i = 0; i < n - 1; i++) {
      if (p.fromS !== undefined && rowS[i + 1] <= p.fromS) continue;
      const prevA = ctx.globalAlpha;
      if (merged) {
        const sm = (rowS[i] + rowS[i + 1]) / 2;
        if (!p.hardEnd)
          ctx.globalAlpha =
            prevA * (1 - smooth01((sm - ARM_DISSOLVE_S0) / Math.max(1, se - ARM_DISSOLVE_S0)));
      }
      for (let j = 0; j < COLS; j++) {
        const a = i * (COLS + 1) + j;
        const b = a + 1;
        const c = a + (COLS + 1);
        const d = c + 1;
        tri(
          ctx,
          img,
          srcX[a],
          srcY[a],
          srcX[b],
          srcY[b],
          srcX[c],
          srcY[c],
          dstX[a],
          dstY[a],
          dstX[b],
          dstY[b],
          dstX[c],
          dstY[c],
        );
        tri(
          ctx,
          img,
          srcX[b],
          srcY[b],
          srcX[d],
          srcY[d],
          srcX[c],
          srcY[c],
          dstX[b],
          dstY[b],
          dstX[d],
          dstY[d],
          dstX[c],
          dstY[c],
        );
      }
      ctx.globalAlpha = prevA;
    }
  // hand frame at ARM_HAND_S
  pos(ARM_HAND_S, tmp);
  armFrame.hx = tmp[0];
  armFrame.hy = tmp[1];
  armFrame.hPsi =
    phiOf(ARM_HAND_S) - sgn * g.theta + Math.PI + (merged ? sgnRot * wRest : sgnRot * p.w);
  armFrame.fore = 1 - raise * 0.75;
  // Soft canvas keep: blend wrist toward an on-canvas aim instead of hard-replacing hPsi.
  if (!merged) armFrame.hPsi = keepOnCanvas(armFrame.hx, armFrame.hy, armFrame.hPsi);
}

/** Soft canvas keep: blend the hand angle toward an on-canvas aim when the fingertips would leave the frame. */
function keepOnCanvas(hx: number, hy: number, psi: number): number {
  const handLen = 300;
  const tipX = hx + Math.sin(psi) * handLen;
  const tipY = hy - Math.cos(psi) * handLen;
  const margin = 48;
  const ox = tipX > 960 - margin || tipX < margin || tipY < margin || tipY > 1120 - margin;
  if (!ox) return psi;
  const tx = Math.max(140, Math.min(820, hx - Math.sign(hx - 480 || 1) * 70));
  const ty = Math.max(140, Math.min(980, hy - 140));
  const aim = Math.atan2(tx - hx, hy - ty);
  let d = aim - psi;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return psi + d * 0.65;
}

/** Draw a hand piece at the attach frame (call right after drawArmStrip). */
/** Scale a hand piece so its authored sleeve width matches the live cuff. */
export function handScaleFor(meta: HandPieceMeta, cuffWidth: number): number {
  // Hands read oversized vs head/torso on Windows; bias small vs cuff width.
  const sw = Math.max(40, meta.sleeveW || 160);
  return Math.max(0.28, Math.min(0.48, (cuffWidth * 0.5) / sw)) * (meta.k ?? 1);
}

export function drawHandPiece(
  ctx: Ctx,
  img: RigImageSource,
  meta: HandPieceMeta,
  sgn: 1 | -1,
  alpha: number,
  scale = HAND_SCALE,
  /** keep only this many source px of sleeve below the cuff line (bilateral prayer joint) */
  keepBelowCuff?: number,
): void {
  if (alpha <= 0.004) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  ctx.save();
  ctx.translate(armFrame.hx, armFrame.hy);
  ctx.rotate(armFrame.hPsi);
  ctx.scale(sgn * scale, scale);
  // Nudge up the sleeve so cuffY sits on the mesh cuff (hand arts include a sleeve stub)
  const cuffLift = Math.max(0, (meta.ay - (meta.cuffY || meta.ay * 0.6)) * 0.2);
  if (keepBelowCuff !== undefined) {
    const yb = Math.min(meta.ay, (meta.cuffY || meta.ay * 0.6) + keepBelowCuff);
    ctx.drawImage(img, 0, 0, meta.w, yb, -meta.ax, -yb, meta.w, yb);
  } else {
    ctx.translate(0, cuffLift);
    ctx.drawImage(img, -meta.ax, -meta.ay);
  }
  ctx.restore();
  ctx.globalAlpha = prev;
}

export const drawArmPieces = drawArmStrip;

const plugCache = new WeakMap<object, CanvasImageSource | null>();
const PLUG_CUT = 120;

/** Upper-sleeve-only cut of the master arm, used to plug the body-noarm shoulder hole. */
export function shoulderPlug(img: RigImageSource, g: ArmGeom): CanvasImageSource | null {
  let cached = plugCache.get(img as object);
  if (cached !== undefined) return cached;
  try {
    const iw = (img as { width: number }).width;
    const ih = (img as { height: number }).height;
    const c0 =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(iw, ih)
        : Object.assign(document.createElement('canvas'), { width: iw, height: ih });
    const x0 = c0.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    x0.drawImage(img as CanvasImageSource, 0, 0);
    const src = x0.getImageData(0, 0, iw, ih);
    const sinT = Math.sin(g.theta);
    const cosT = Math.cos(g.theta);
    const ux = g.sgn * sinT;
    const uy = cosT;
    const sOf = (x: number, y: number) => (x - g.s0[0]) * ux + (y - g.s0[1]) * uy;
    const out = new Uint8ClampedArray(src.data);
    // Keep upper sleeve through near-elbow so the body-noarm void stays sealed when the
    // mesh rotates away. Soft feather over ~50px so it does not read as a second cuff.
    const cut = PLUG_CUT;
    for (let y = 0; y < ih; y++)
      for (let x = 0; x < iw; x++) {
        const k = (y * iw + x) * 4 + 3;
        if (!out[k]) continue;
        const t = (sOf(x, y) - (cut - 50)) / 50;
        const f = t <= 0 ? 1 : t >= 1 ? 0 : 1 - t * t * (3 - 2 * t);
        out[k] = Math.round(out[k] * f);
      }
    const c =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(iw, ih)
        : Object.assign(document.createElement('canvas'), { width: iw, height: ih });
    (c.getContext('2d') as CanvasRenderingContext2D).putImageData(new ImageData(out, iw, ih), 0, 0);
    cached = c as unknown as CanvasImageSource;
  } catch {
    cached = null;
  }
  plugCache.set(img as object, cached);
  return cached;
}

const sideFillCache = new WeakMap<object, Record<string, CanvasImageSource | null>>();

/**
 * Everything opaque on `body` but transparent on `body-noarm` on one side of the torso
 * (the full sleeve-free void). Drawn for the arm that is NOT posed so the rest arm never
 * leaves a see-through seam against the sleeve-free body. `side` 'l' = left half of the image.
 */
export function bodySideFill(
  body: RigImageSource,
  bodyNoarm: RigImageSource,
  side: 'l' | 'r',
  /** body-local shoulder; when set only the upper-arm void within `radius` is filled (posed arm) */
  shoulder?: readonly [number, number],
  radius = 240,
): CanvasImageSource | null {
  const key = body as object;
  const entry: Record<string, CanvasImageSource | null> = sideFillCache.get(key) ?? {};
  sideFillCache.set(key, entry);
  const ck = shoulder ? `${side}p${Math.round(radius)}` : side;
  if (entry[ck] !== undefined) return entry[ck] ?? null;
  let out: CanvasImageSource | null;
  try {
    const bw = (body as { width: number }).width;
    const bh = (body as { height: number }).height;
    const mk = (img: RigImageSource) => {
      const c =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(bw, bh)
          : Object.assign(document.createElement('canvas'), { width: bw, height: bh });
      const x = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      x.clearRect(0, 0, bw, bh);
      x.drawImage(img as CanvasImageSource, 0, 0);
      return x.getImageData(0, 0, bw, bh);
    };
    const dBody = mk(body);
    const dNo = mk(bodyNoarm);
    const px = new Uint8ClampedArray(bw * bh * 4);
    const mid = bw / 2;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        if (side === 'l' ? x >= mid : x < mid) continue;
        const i = (y * bw + x) * 4;
        const a = dBody.data[i + 3];
        const cover = dNo.data[i + 3];
        if (a < 8 || cover >= 250) continue;
        px[i] = dBody.data[i];
        px[i + 1] = dBody.data[i + 1];
        px[i + 2] = dBody.data[i + 2];
        let f = 1;
        if (shoulder) {
          const dist = Math.hypot(x - shoulder[0], y - shoulder[1]);
          f = dist < radius - 40 ? 1 : Math.max(0, 1 - (dist - (radius - 40)) / 40);
        }
        px[i + 3] = Math.round(a * (1 - cover / 255) * f);
      }
    }
    const c =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(bw, bh)
        : Object.assign(document.createElement('canvas'), { width: bw, height: bh });
    (c.getContext('2d') as CanvasRenderingContext2D).putImageData(new ImageData(px, bw, bh), 0, 0);
    out = c as unknown as CanvasImageSource;
  } catch {
    out = null;
  }
  entry[ck] = out;
  return out;
}

const bodyFillCache = new WeakMap<object, CanvasImageSource | null>();

/**
 * Pixels that are opaque on `body` but transparent on `body-noarm` near the shoulder —
 * the armpit notch the arm layer never covers. Cached per body image.
 */
export function bodyShoulderFill(
  body: RigImageSource,
  bodyNoarm: RigImageSource,
  bodyOff: readonly [number, number],
  shoulder: readonly [number, number],
  radius = 150,
): CanvasImageSource | null {
  const key = body as object;
  let cached = bodyFillCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const bw = (body as { width: number }).width;
    const bh = (body as { height: number }).height;
    const mk = (img: RigImageSource) => {
      const c =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(bw, bh)
          : Object.assign(document.createElement('canvas'), { width: bw, height: bh });
      const x = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      x.clearRect(0, 0, bw, bh);
      x.drawImage(img as CanvasImageSource, 0, 0);
      return x.getImageData(0, 0, bw, bh);
    };
    const dBody = mk(body);
    const dNo = mk(bodyNoarm);
    const out = new Uint8ClampedArray(bw * bh * 4);
    // shoulder in body-local px
    const sx = shoulder[0] - bodyOff[0];
    const sy = shoulder[1] - bodyOff[1];
    const r2 = radius * radius;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = (y * bw + x) * 4;
        if (dBody.data[i + 3] < 20 || dNo.data[i + 3] > 10) continue;
        const dx = x - sx;
        const dy = y - sy;
        if (dx * dx + dy * dy > r2) continue;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const f = dist < radius - 30 ? 1 : Math.max(0, 1 - (dist - (radius - 30)) / 30);
        out[i] = dBody.data[i];
        out[i + 1] = dBody.data[i + 1];
        out[i + 2] = dBody.data[i + 2];
        out[i + 3] = Math.round(dBody.data[i + 3] * f);
      }
    }
    const c =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(bw, bh)
        : Object.assign(document.createElement('canvas'), { width: bw, height: bh });
    (c.getContext('2d') as CanvasRenderingContext2D).putImageData(new ImageData(out, bw, bh), 0, 0);
    cached = c as unknown as CanvasImageSource;
  } catch {
    cached = null;
  }
  bodyFillCache.set(key, cached);
  return cached;
}
