/**
 * Vector overlays (hearts, sparkles, ?, !, tears …) and procedural face parts (brows, extra
 * mouths) for the Nomi rig. Everything is drawn from paths in the brand palette; nothing here
 * touches the master artwork layers. All functions are allocation-free (no arrays / closures).
 */
import { IDX } from './params';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Brand palette (sampled from the approved artwork). */
export const FX = {
  orange: '#f39c48',
  orangeDeep: '#e8742a',
  gold: '#ffd166',
  cream: '#fff4e2',
  heart: '#f27a6a',
  heartDeep: '#d9524a',
  line: '#7a3b1e',
  tear: '#9fd8ff',
  tearDeep: '#4f98c8',
  gloom: '#5b6a96',
  blush: '#ea6a62',
  mouth: '#96463f',
  mouthIn: '#6e2b2e',
  tongue: '#f08a8a',
  brow: '#3a2218',
} as const;

const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);
const sat = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function heart(ctx: Ctx, x: number, y: number, s: number, rot: number, alpha: number): void {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.moveTo(0, s * 0.95);
  ctx.bezierCurveTo(-s * 1.45, s * 0.05, -s * 0.8, -s * 1.0, 0, -s * 0.38);
  ctx.bezierCurveTo(s * 0.8, -s * 1.0, s * 1.45, s * 0.05, 0, s * 0.95);
  ctx.closePath();
  ctx.fillStyle = FX.heart;
  ctx.strokeStyle = FX.heartDeep;
  ctx.lineWidth = Math.max(1.5, s * 0.14);
  ctx.lineJoin = 'round';
  ctx.fill();
  ctx.stroke();
  // highlight
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.beginPath();
  ctx.ellipse(-s * 0.5, -s * 0.2, s * 0.17, s * 0.1, -0.7, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function sparkle(
  ctx: Ctx,
  x: number,
  y: number,
  s: number,
  rot: number,
  alpha: number,
  c: string,
): void {
  if (alpha <= 0.01 || s <= 0.5) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.quadraticCurveTo(s * 0.12, -s * 0.12, s, 0);
  ctx.quadraticCurveTo(s * 0.12, s * 0.12, 0, s);
  ctx.quadraticCurveTo(-s * 0.12, s * 0.12, -s, 0);
  ctx.quadraticCurveTo(-s * 0.12, -s * 0.12, 0, -s);
  ctx.closePath();
  ctx.fillStyle = c;
  ctx.fill();
  ctx.strokeStyle = FX.orangeDeep;
  ctx.lineWidth = Math.max(1, s * 0.07);
  ctx.globalAlpha *= 0.55;
  ctx.stroke();
  ctx.restore();
}

function star5(ctx: Ctx, x: number, y: number, s: number, rot: number, alpha: number): void {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? s : s * 0.45;
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = FX.gold;
  ctx.strokeStyle = FX.orangeDeep;
  ctx.lineWidth = Math.max(1.2, s * 0.12);
  ctx.lineJoin = 'round';
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drop(ctx: Ctx, x: number, y: number, s: number, alpha: number): void {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, -s * 1.5);
  ctx.quadraticCurveTo(s * 1.1, s * 0.15, 0, s);
  ctx.quadraticCurveTo(-s * 1.1, s * 0.15, 0, -s * 1.5);
  ctx.closePath();
  ctx.fillStyle = FX.tear;
  ctx.strokeStyle = FX.tearDeep;
  ctx.lineWidth = Math.max(1.2, s * 0.22);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.ellipse(-s * 0.3, -s * 0.1, s * 0.18, s * 0.34, 0.3, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function questionMark(ctx: Ctx, x: number, y: number, s: number, rot: number, alpha: number): void {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = FX.line;
  ctx.lineWidth = s * 0.62;
  ctx.beginPath();
  ctx.moveTo(-s * 0.5, -s * 0.55);
  ctx.bezierCurveTo(-s * 0.5, -s * 1.15, s * 0.6, -s * 1.15, s * 0.6, -s * 0.5);
  ctx.bezierCurveTo(s * 0.6, -s * 0.05, 0, -s * 0.05, 0, s * 0.45);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, s * 0.95, s * 0.09, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = FX.orange;
  ctx.lineWidth = s * 0.4;
  ctx.beginPath();
  ctx.moveTo(-s * 0.5, -s * 0.55);
  ctx.bezierCurveTo(-s * 0.5, -s * 1.15, s * 0.6, -s * 1.15, s * 0.6, -s * 0.5);
  ctx.bezierCurveTo(s * 0.6, -s * 0.05, 0, -s * 0.05, 0, s * 0.45);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, s * 0.95, s * 0.09, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

function exclaim(ctx: Ctx, x: number, y: number, s: number, rot: number, alpha: number): void {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.lineCap = 'round';
  ctx.strokeStyle = FX.line;
  ctx.lineWidth = s * 0.66;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(0, s * 0.25);
  ctx.moveTo(0, s * 0.82);
  ctx.lineTo(0, s * 0.84);
  ctx.stroke();
  ctx.strokeStyle = FX.orange;
  ctx.lineWidth = s * 0.42;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(0, s * 0.25);
  ctx.moveTo(0, s * 0.82);
  ctx.lineTo(0, s * 0.84);
  ctx.stroke();
  ctx.restore();
}

function note(ctx: Ctx, x: number, y: number, s: number, rot: number, alpha: number): void {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = FX.orangeDeep;
  ctx.strokeStyle = FX.orangeDeep;
  ctx.lineWidth = s * 0.16;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.ellipse(0, s * 0.6, s * 0.38, s * 0.28, -0.4, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(s * 0.32, s * 0.5);
  ctx.lineTo(s * 0.32, -s * 0.9);
  ctx.quadraticCurveTo(s * 0.9, -s * 0.7, s * 0.7, -s * 0.1);
  ctx.stroke();
  ctx.restore();
}

function zed(ctx: Ctx, x: number, y: number, s: number, alpha: number): void {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = FX.gloom;
  ctx.lineWidth = s * 0.3;
  ctx.beginPath();
  ctx.moveTo(-s * 0.5, -s * 0.5);
  ctx.lineTo(s * 0.5, -s * 0.5);
  ctx.lineTo(-s * 0.5, s * 0.5);
  ctx.lineTo(s * 0.5, s * 0.5);
  ctx.stroke();
  ctx.restore();
}

/** Floating / popping effects in head space (call before the head transform is restored). */
export function drawFx(
  ctx: Ctx,
  headTop: readonly [number, number],
  eyeL: readonly [number, number],
  eyeR: readonly [number, number],
  cheekL: readonly [number, number],
  cheekR: readonly [number, number],
  v: Float32Array,
  t: number,
  reduced: boolean,
): void {
  const bx = headTop[0];
  const by = headTop[1];
  const tt = reduced ? 0 : t;
  let k = v[IDX.fxHeart];
  if (k > 0.02) {
    for (let i = 0; i < 3; i++) {
      const ph = reduced ? 0.35 + i * 0.25 : frac(tt * 0.55 + i / 3);
      const x = bx + 215 + Math.sin(ph * 6 + i * 2.1) * 16 + i * 8;
      const y = by + 170 - ph * 140;
      heart(
        ctx,
        x,
        y,
        (12 + 12 * ph) * (0.6 + 0.4 * k),
        Math.sin(ph * 5 + i) * 0.25,
        Math.sin(Math.PI * ph) * k,
      );
    }
  }
  k = v[IDX.fxSparkle];
  if (k > 0.02) {
    for (let i = 0; i < 5; i++) {
      const ph = 0.5 + 0.5 * Math.sin(tt * 4.2 + i * 1.9);
      const sx = i % 2 === 0 ? -1 : 1;
      const x = bx + sx * (170 + (i % 3) * 38);
      const y = by + 40 + ((i * 53) % 190);
      sparkle(
        ctx,
        x,
        y,
        (10 + 14 * ph) * k * (i === 0 ? 1.3 : 1),
        tt * 0.6 + i,
        k * (0.55 + 0.45 * ph),
        i % 2 ? FX.gold : FX.cream,
      );
    }
  }
  k = v[IDX.fxStar];
  if (k > 0.02) {
    for (let i = 0; i < 7; i++) {
      const ph = reduced ? 0.4 : frac(tt * 0.7 + i * 0.143);
      const ang = i * 0.9 + 0.4;
      const r = 150 + ph * 120;
      star5(
        ctx,
        bx + Math.cos(ang) * r * 1.25,
        by + 140 + Math.sin(ang) * r * 0.75 - 30,
        8 + 7 * (i % 3),
        tt * 2 + i,
        Math.sin(Math.PI * ph) * k,
      );
    }
  }
  k = v[IDX.fxQuestion];
  if (k > 0.02) {
    const pop = 1 + 0.12 * Math.sin(tt * 6);
    questionMark(
      ctx,
      bx + 190,
      by + 5 + 4 * Math.sin(tt * 3.4),
      30 * pop * (0.6 + 0.4 * k),
      0.2 + 0.12 * Math.sin(tt * 4),
      k,
    );
  }
  k = v[IDX.fxExclaim];
  if (k > 0.02) {
    const pop = 1 + 0.18 * Math.sin(tt * 9) * (1 - k * 0.5);
    exclaim(ctx, bx + 200, by + 20, 32 * pop * (0.6 + 0.4 * k), -0.18, k);
  }
  k = v[IDX.fxNote];
  if (k > 0.02) {
    for (let i = 0; i < 2; i++) {
      const ph = reduced ? 0.4 + i * 0.3 : frac(tt * 0.5 + i * 0.5);
      note(
        ctx,
        bx + (i ? -210 : 220) + Math.sin(ph * 7) * 12,
        by + 190 - ph * 150,
        22,
        Math.sin(ph * 6 + i) * 0.3,
        Math.sin(Math.PI * ph) * k,
      );
    }
  }
  k = v[IDX.fxZzz];
  if (k > 0.02) {
    for (let i = 0; i < 3; i++) {
      const ph = reduced ? 0.3 + i * 0.25 : frac(tt * 0.35 + i / 3);
      zed(
        ctx,
        bx + 190 + i * 38 + ph * 20,
        by + 150 - i * 44 - ph * 40,
        14 + i * 7 + ph * 6,
        Math.sin(Math.PI * ph) * k,
      );
    }
  }
  k = v[IDX.fxSweat];
  if (k > 0.02) {
    const ph = reduced ? 0.4 : frac(tt * 0.6);
    drop(ctx, bx - 190, by + 150 + ph * 34, 11 * (0.7 + 0.3 * k), k * (1 - ph * 0.4));
  }
  k = v[IDX.fxTear];
  if (k > 0.02) {
    for (let s = 0; s < 2; s++) {
      const e = s === 0 ? eyeL : eyeR;
      const ph = reduced ? 0.5 : frac(tt * 0.7 + s * 0.4);
      // pooled tear on the lower lid + one running drop
      drop(
        ctx,
        e[0] + (s === 0 ? -6 : 6),
        e[1] + 22 + ph * 52,
        6.5,
        k * Math.sin(Math.PI * Math.min(1, ph + 0.15)),
      );
      ctx.save();
      ctx.globalAlpha *= 0.55 * k;
      ctx.strokeStyle = FX.tear;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(e[0] - 18, e[1] + 24);
      ctx.quadraticCurveTo(e[0], e[1] + 31, e[0] + 18, e[1] + 24);
      ctx.stroke();
      ctx.restore();
    }
  }
  k = v[IDX.fxBlush];
  if (k > 0.02) {
    ctx.save();
    ctx.globalAlpha *= 0.75 * k;
    ctx.strokeStyle = FX.blush;
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let s = 0; s < 2; s++) {
      const c = s === 0 ? cheekL : cheekR;
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(c[0] + i * 11 - 6, c[1] + 10);
        ctx.lineTo(c[0] + i * 11 + 4, c[1] - 8);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
  k = v[IDX.fxGloom];
  if (k > 0.02) {
    ctx.save();
    ctx.globalAlpha *= 0.7 * k;
    ctx.strokeStyle = FX.gloom;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const x = bx - 110 + i * 44;
      const len = 36 + (i % 3) * 14 + sat(k) * 8;
      ctx.moveTo(x, by + 8);
      ctx.lineTo(x + 3, by + 8 + len);
    }
    ctx.stroke();
    ctx.restore();
  }
  k = v[IDX.fxAnger];
  if (k > 0.02) {
    const x = bx + 150;
    const y = by + 44;
    const pul = 1 + 0.1 * Math.sin(tt * 12);
    ctx.save();
    ctx.globalAlpha *= k;
    ctx.translate(x, y);
    ctx.scale(pul, pul);
    ctx.strokeStyle = '#e8432f';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const dx = i & 1 ? -1 : 1;
      const dy = i & 2 ? -1 : 1;
      const ang = Math.atan2(-dy, -dx);
      ctx.beginPath();
      ctx.arc(dx * 16, dy * 16, 10, ang - Math.PI / 2, ang + Math.PI / 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Brow strokes (semi-transparent so they read through the fringe). kind: 1 up 2 down 3 worried 4 angry 5 soft */
export function drawBrow(
  ctx: Ctx,
  kind: number,
  x0: number,
  x1: number,
  top: number,
  inner: 1 | -1,
  alpha: number,
): void {
  if (kind <= 0 || alpha <= 0.01) return;
  // inner end = the end towards the nose; `inner` = +1 when inner end is x1
  const xi = inner > 0 ? x1 : x0;
  const xo = inner > 0 ? x0 : x1;
  let yi: number;
  let yo: number;
  let bow: number;
  if (kind === 1) {
    yi = yo = top - 31;
    bow = -8;
  } else if (kind === 2) {
    yi = yo = top - 13;
    bow = -1;
  } else if (kind === 3) {
    yi = top - 29;
    yo = top - 14;
    bow = -3;
  } else if (kind === 4) {
    yi = top - 11;
    yo = top - 27;
    bow = -2;
  } else {
    yi = yo = top - 21;
    bow = -6;
  }
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = FX.brow;
  ctx.lineCap = 'round';
  ctx.lineWidth = 3.6;
  ctx.beginPath();
  ctx.moveTo(xo, yo);
  ctx.quadraticCurveTo((xi + xo) / 2, (yi + yo) / 2 + bow, xi, yi);
  ctx.stroke();
  ctx.restore();
}

/** Extra mouths drawn from strokes. kind: 6 wavy 7 cat(ω) 8 tongue 9 grin 10 yawn 11 pout 2 smile */
export function drawMouth(ctx: Ctx, kind: number, cx: number, cy: number, open: number): boolean {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = FX.mouth;
  ctx.fillStyle = FX.mouthIn;
  ctx.lineWidth = 3.4;
  let drawn = true;
  switch (kind) {
    case 6: {
      ctx.beginPath();
      ctx.moveTo(cx - 24, cy);
      ctx.bezierCurveTo(cx - 16, cy - 7, cx - 8, cy - 7, cx - 1, cy);
      ctx.bezierCurveTo(cx + 7, cy + 7, cx + 15, cy + 7, cx + 24, cy);
      ctx.stroke();
      break;
    }
    case 7: {
      ctx.beginPath();
      ctx.moveTo(cx - 20, cy - 4);
      ctx.quadraticCurveTo(cx - 12, cy + 9, cx, cy);
      ctx.quadraticCurveTo(cx + 12, cy + 9, cx + 20, cy - 4);
      ctx.stroke();
      break;
    }
    case 8: {
      // small open mouth with tongue
      ctx.beginPath();
      ctx.moveTo(cx - 20, cy - 3);
      ctx.quadraticCurveTo(cx, cy + 4, cx + 20, cy - 3);
      ctx.quadraticCurveTo(cx + 14, cy + 20, cx, cy + 20);
      ctx.quadraticCurveTo(cx - 14, cy + 20, cx - 20, cy - 3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = FX.tongue;
      ctx.beginPath();
      ctx.ellipse(cx, cy + 14, 10, 6.5, 0, 0, TAU);
      ctx.fill();
      break;
    }
    case 9: {
      const h = 14 + 8 * open;
      ctx.beginPath();
      ctx.moveTo(cx - 26, cy - 3);
      ctx.quadraticCurveTo(cx, cy + 4, cx + 26, cy - 3);
      ctx.quadraticCurveTo(cx + 20, cy + h, cx, cy + h);
      ctx.quadraticCurveTo(cx - 20, cy + h, cx - 26, cy - 3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = FX.cream;
      ctx.beginPath();
      ctx.moveTo(cx - 20, cy - 1);
      ctx.quadraticCurveTo(cx, cy + 5, cx + 20, cy - 1);
      ctx.lineTo(cx + 18, cy + 4);
      ctx.quadraticCurveTo(cx, cy + 9, cx - 18, cy + 4);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 10: {
      const rx = 16 + 6 * open;
      const ry = 17 + 17 * open;
      ctx.beginPath();
      ctx.ellipse(cx, cy + ry * 0.45, rx, ry, 0, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = FX.tongue;
      ctx.beginPath();
      ctx.ellipse(cx, cy + ry * 1.05, rx * 0.62, ry * 0.32, 0, 0, TAU);
      ctx.fill();
      break;
    }
    case 11: {
      ctx.beginPath();
      ctx.ellipse(cx, cy + 3, 7, 5, 0, 0, TAU);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 2: {
      ctx.beginPath();
      ctx.moveTo(cx - 22, cy - 3);
      ctx.quadraticCurveTo(cx, cy + 10, cx + 22, cy - 3);
      ctx.stroke();
      break;
    }
    default:
      drawn = false;
  }
  ctx.restore();
  return drawn;
}
