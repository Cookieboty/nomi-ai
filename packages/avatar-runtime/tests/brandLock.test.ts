import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { repoPath } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

import { RigAnimator, drawRig, type RigImages, type RigManifest } from '../src/layeredRig';
import { ACTIONS } from '../src/rig/actions';

/**
 * Brand lock — the Nomi artwork may only be moved / rotated, never redrawn:
 *  1. every master layer PNG is hashed against the committed manifest (brand-lock.json),
 *  2. the placement of the layers (offsets / anchors / pivots) is hashed too,
 *  3. for every action, every frame: each brand layer is drawn, fully opaque, and through a rigid
 *     transform (rotation + uniform scale only — no shear, no squash) that keeps it on canvas.
 */
const MODEL = process.env.CHARACTER_PACK_SPRITE_DIR
  ? path.resolve(process.env.CHARACTER_PACK_SPRITE_DIR)
  : repoPath('characters/nomi/sprite');

const SKIP_BRAND = process.env.CHARACTER_PACK_SKIP_BRAND_LOCK === '1';
const describeBrand = SKIP_BRAND ? describe.skip : describe;
const manifest = SKIP_BRAND
  ? ({ rig: { layers: {}, actions: {} } } as unknown as { rig: RigManifest })
  : (JSON.parse(fs.readFileSync(path.join(MODEL, 'manifest.json'), 'utf8')) as {
      rig: RigManifest;
    });
const lock = SKIP_BRAND
  ? ({ layout: '', files: {} } as { layout: string; files: Record<string, string> })
  : (JSON.parse(fs.readFileSync(path.join(MODEL, 'brand-lock.json'), 'utf8')) as {
      layout: string;
      files: Record<string, string>;
    });
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** layers that carry the brand identity (everything the user approved as artwork) */
const BRAND_LAYERS = [
  'head',
  'crown',
  'bangs',
  'hair-side-l',
  'hair-side-r',
  'ribbon', // orange bow of the N hairclip
  'clip', // N hairclip
  'earring',
  'body', // jacket, tank top, chest N logo, choker charm, belt …
  'badge', // ID tag
] as const;
/** locked as art, but an arm attachment: it fades out while the right arm is posed (mesh sleeve) */
const ARM_ATTACHMENTS = ['strap-r'];

describeBrand('brand lock: files', () => {
  it('every locked layer matches its committed sha256', () => {
    const names = Object.keys(lock.files);
    expect(names.length).toBeGreaterThanOrEqual(28);
    for (const n of names) expect(sha(path.join(MODEL, n)), n).toBe(lock.files[n]);
  });

  it('no layer file is missing from the lock (new art must be locked on purpose)', () => {
    const walk = (d: string, base = ''): string[] =>
      fs.readdirSync(path.join(d, base), { withFileTypes: true }).flatMap((e) => {
        const rel = base ? `${base}/${e.name}` : e.name;
        return e.isDirectory() ? walk(d, rel) : rel.endsWith('.png') ? [rel] : [];
      });
    const onDisk = walk(MODEL, 'layers').sort();
    expect(onDisk).toEqual(Object.keys(lock.files).sort());
  });

  it('brand layers and their placement are locked', () => {
    for (const n of [...BRAND_LAYERS, ...ARM_ATTACHMENTS]) {
      expect(manifest.rig.layers[n], n).toBeTruthy();
      expect(lock.files[`layers/${n}.png`], n).toMatch(/^[0-9a-f]{64}$/);
    }
    const rig = manifest.rig;
    const canon = JSON.stringify({ layers: rig.layers, anchors: rig.anchors, pivots: rig.pivots });
    expect(createHash('sha256').update(canon).digest('hex')).toBe(lock.layout);
  });
});

// ---- minimal canvas that records matrices of drawImage calls --------------------------------
type M = [number, number, number, number, number, number];
interface DrawCall {
  name: string;
  m: M;
  w: number;
  h: number;
  alpha: number;
}
const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[2] * q[1],
  p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3],
  p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4],
  p[1] * q[4] + p[3] * q[5] + p[5],
];
function fakeCtx(calls: DrawCall[]) {
  let m: M = [1, 0, 0, 1, 0, 0];
  const stack: Array<{ m: M; a: number }> = [];
  const st = { globalAlpha: 1 } as Record<string, unknown> & { globalAlpha: number };
  const noop = () => undefined;
  const target: Record<string, unknown> = {
    save: () => stack.push({ m: [...m] as M, a: st.globalAlpha }),
    restore: () => {
      const s = stack.pop();
      if (s) {
        m = s.m;
        st.globalAlpha = s.a;
      }
    },
    translate: (x: number, y: number) => (m = mul(m, [1, 0, 0, 1, x, y])),
    scale: (x: number, y: number) => (m = mul(m, [x, 0, 0, y, 0, 0])),
    rotate: (r: number) =>
      (m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0])),
    transform: (a: number, b: number, c: number, d: number, e: number, f: number) =>
      (m = mul(m, [a, b, c, d, e, f])),
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) =>
      (m = [a, b, c, d, e, f]),
    getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }),
    drawImage: (img: { __name?: string; width: number; height: number }, ...a: number[]) => {
      if (!img.__name) return;
      const [dx = 0, dy = 0, dw, dh] = a;
      const sx = dw !== undefined ? dw / img.width : 1;
      const sy = dh !== undefined ? dh / img.height : 1;
      calls.push({
        name: img.__name,
        m: mul(m, [sx, 0, 0, sy, dx, dy]),
        w: img.width,
        h: img.height,
        alpha: st.globalAlpha,
      });
    },
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    measureText: () => ({ width: 10 }),
    canvas: { width: 960, height: 1120 },
  };
  return new Proxy(target, {
    get: (t, k: string) => (k in t ? t[k] : k in st ? st[k] : noop),
    set: (_t, k: string, v) => {
      st[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function fakeImages(rig: RigManifest): RigImages {
  const imgs: RigImages = new Map();
  const dims = (n: string): [number, number] => {
    const f = path.join(MODEL, rig.dir ?? 'layers/', `${n}.png`);
    if (!fs.existsSync(f)) return [64, 64];
    const b = fs.readFileSync(f);
    return [b.readUInt32BE(16), b.readUInt32BE(20)]; // PNG IHDR
  };
  for (const n of Object.keys(rig.layers)) {
    const [width, height] = dims(n);
    imgs.set(n, { __name: n, width, height } as unknown as RigImages extends Map<string, infer I>
      ? I
      : never);
  }
  for (const [n, h] of Object.entries(rig.hands ?? {})) {
    imgs.set(`hand-${n}`, { __name: `hand-${n}`, width: h.w, height: h.h } as never);
  }
  return imgs;
}

const rig = manifest.rig;
const imgs = fakeImages(rig);

// the rig composes eyes / arm fades on scratch canvases: give it throw-away fake ones
class FakeOffscreen {
  private readonly g = fakeCtx([]);
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return this.g;
  }
}
(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeOffscreen;

function frameCalls(pose: ReturnType<RigAnimator['step']>): DrawCall[] {
  const calls: DrawCall[] = [];
  drawRig(fakeCtx(calls), rig, imgs, pose);
  return calls;
}

const BASE_INPUT = {
  expression: 'neutral',
  mouth: 0,
  talking: false,
  blink: 0,
  lookX: 0,
  lookY: 0,
};

describeBrand('brand lock: every action keeps the artwork rigid', () => {
  const ids = ACTIONS.map((a) => a.id);

  it('idle frame draws every brand layer and arm attachment', () => {
    const a = new RigAnimator(7);
    let pose;
    for (let i = 0; i < 20; i++) pose = a.step(1 / 30, i / 30, BASE_INPUT);
    const names = frameCalls(pose!).map((c) => c.name);
    for (const n of [...BRAND_LAYERS, ...ARM_ATTACHMENTS]) expect(names, n).toContain(n);
  });

  it('has at least 30 actions', () => {
    expect(ids.length).toBeGreaterThanOrEqual(30);
  });

  for (const id of ids) {
    it(`${id}: brand layers drawn opaque, unsheared, uniformly scaled, on canvas`, () => {
      const a = new RigAnimator(7);
      let t = 0;
      const dt = 1 / 30;
      for (let i = 0; i < 20; i++) {
        a.step(dt, t, BASE_INPUT);
        t += dt;
      }
      const def = a.actions.def(id)!;
      const total = Math.min(def.dur + 0.9, 6);
      let first = true;
      for (let k = 0; k * dt < total; k++) {
        const pose = a.step(dt, t, {
          ...BASE_INPUT,
          gesture: first ? { name: id, id: 1 } : undefined,
        });
        first = false;
        t += dt;
        if (k % 3) continue;
        const calls = frameCalls(pose);
        for (const n of BRAND_LAYERS) {
          // with a posed arm the body is drawn as its derived `body-noarm` variant (same art)
          const c = calls.find((x) => x.name === n || (n === 'body' && x.name === 'body-noarm'));
          expect(c, `${id}@${k}: ${n} not drawn`).toBeTruthy();
          if (!c) continue;
          const [A, B, C, D] = c.m;
          const k0 = rig.layers[n][2] ?? 1; // drawn layer scale (head art is stored at 1/0.66)
          const sx = Math.hypot(A, B) / k0;
          const sy = Math.hypot(C, D) / k0;
          expect(c.alpha, `${id}@${k}: ${n} alpha`).toBeGreaterThanOrEqual(0.999);
          // rotation + uniform scale: columns orthogonal, equal length
          expect(Math.abs(A * C + B * D) / (sx * sy), `${id}@${k}: ${n} shear`).toBeLessThan(0.02);
          expect(Math.abs(sx / sy - 1), `${id}@${k}: ${n} squash`).toBeLessThan(0.06);
          // the figure never scales beyond ±10 % (head layers carry the figure scale only)
          expect(sx, `${id}@${k}: ${n} scale`).toBeGreaterThan(0.9);
          expect(sx, `${id}@${k}: ${n} scale`).toBeLessThan(1.1);
        }
        // head-attached brand parts move as ONE rigid group (same rotation / scale as the head)
        const head = calls.find((x) => x.name === 'head')!;
        const rot = Math.atan2(head.m[1], head.m[0]);
        for (const n of ['clip', 'ribbon', 'earring', 'bangs', 'crown']) {
          const c = calls.find((x) => x.name === n)!;
          // the bow may flutter up to ~17° around its clip (rigid rotation, secondary motion)
          expect(Math.abs(Math.atan2(c.m[1], c.m[0]) - rot), `${id}@${k}: ${n} rot`).toBeLessThan(
            n === 'ribbon' ? 0.3 : 0.01,
          );
          expect(
            Math.abs(
              Math.hypot(c.m[0], c.m[1]) / (rig.layers[n][2] ?? 1) -
                Math.hypot(head.m[0], head.m[1]) / (rig.layers.head[2] ?? 1),
            ),
          ).toBeLessThan(0.01);
        }
        // hair clip / ribbon stay inside the canvas
        for (const n of ['clip', 'ribbon', 'earring']) {
          const c = calls.find((x) => x.name === n)!;
          for (const [x, y] of [
            [0, 0],
            [c.w, 0],
            [0, c.h],
            [c.w, c.h],
          ]) {
            const px = c.m[0] * x + c.m[2] * y + c.m[4];
            const py = c.m[1] * x + c.m[3] * y + c.m[5];
            expect(px, `${id}@${k}: ${n} x`).toBeGreaterThan(0);
            expect(px).toBeLessThan(rig.size[0]);
            expect(py).toBeGreaterThan(0);
            expect(py).toBeLessThan(rig.size[1]);
          }
        }
      }
    });
  }
});
