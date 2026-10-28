import { describe, expect, it } from 'vitest';

import { createSpriteBackend, type SpriteManifest } from '../src/backends/sprite';
import {
  BLINK_DURATION,
  blinkCurve,
  EXPRESSION_STYLES,
  noise1,
  RigAnimator,
  type RigInput,
  type RigPose,
} from '../src/layeredRig';

const base: RigInput = {
  expression: 'neutral',
  mouth: 0,
  talking: false,
  blink: 0,
  lookX: 0,
  lookY: 0,
};

function run(anim: RigAnimator, input: Partial<RigInput>, secs = 1, t0 = 0) {
  let pose = anim.step(1 / 60, t0, { ...base, ...input });
  for (let i = 1; i < secs * 60; i++) pose = anim.step(1 / 60, t0 + i / 60, { ...base, ...input });
  return pose;
}

describe('layered rig animator', () => {
  it('maps every mascot emotion to a style', () => {
    for (const e of [
      'neutral',
      'happy',
      'relaxed',
      'sad',
      'angry',
      'surprised',
      'talking',
      'blink',
    ]) {
      expect(EXPRESSION_STYLES[e]).toBeDefined();
    }
  });

  it('breathes in idle, but holds still with reduced motion', () => {
    const a = new RigAnimator();
    const ps: RigPose[] = [];
    for (let i = 0; i < 300; i++) ps.push(a.step(1 / 60, i / 60, base));
    const sh = ps.map((p) => p.shoulderL);
    const sc = ps.map((p) => p.bodyScaleY);
    expect(Math.max(...sh) - Math.min(...sh)).toBeGreaterThan(1.5);
    expect(Math.max(...sc) - Math.min(...sc)).toBeGreaterThan(0.004);
    const r = new RigAnimator();
    const rs = [0.2, 0.6, 1.0].map((t) => r.step(1 / 60, t, { ...base, reducedMotion: true }));
    expect(rs.every((p) => p.bodyY === 0 && Math.abs(p.hairRotL) < 1e-6 && p.torsoX === 0)).toBe(
      true,
    );
  });

  it('blinks over several frames with a slower reopen', () => {
    expect(blinkCurve(0)).toBe(0);
    const half = blinkCurve(0.03);
    expect(half).toBeGreaterThan(0.2);
    expect(half).toBeLessThan(0.8);
    expect(blinkCurve(0.07)).toBe(1);
    expect(blinkCurve(BLINK_DURATION + 0.01)).toBe(0);
    expect(BLINK_DURATION).toBeGreaterThanOrEqual(0.12);
    expect(BLINK_DURATION).toBeLessThanOrEqual(0.18);
    // reopen (85 ms) is slower than closing (60 ms)
    expect(blinkCurve(0.085 + 0.04)).toBeGreaterThan(1 - blinkCurve(0.04) - 0.2);
    const frames: number[] = [];
    for (let i = 0; i <= 10; i++) frames.push(blinkCurve(i / 60));
    expect(frames.filter((v) => v > 0.05 && v < 0.95).length).toBeGreaterThanOrEqual(3);
  });

  it('closes eyes on an external blink and blinks on its own', () => {
    const p = run(new RigAnimator(), { blink: 1 }, 0.5);
    expect(p.lidClose).toBeGreaterThan(0.95);
    expect(p.lidAlpha).toBeGreaterThan(0.9);
    const a = new RigAnimator(3);
    let mx = 0;
    for (let i = 0; i < 60 * 7; i++) mx = Math.max(mx, a.step(1 / 60, i / 60, base).lidClose);
    expect(mx).toBeGreaterThan(0.9);
  });

  it('head follows the cursor without overshoot while the eyes lead', () => {
    const a = new RigAnimator();
    run(a, {}, 1);
    const early = run(a, { lookX: 1 }, 0.1, 1);
    expect(early.irisX).toBeGreaterThan(0.8);
    const xs: number[] = [];
    for (let i = 0; i < 180; i++)
      xs.push(a.step(1 / 60, 1.1 + i / 60, { ...base, lookX: 1, reducedMotion: true }).headX);
    expect(Math.max(...xs)).toBeLessThanOrEqual(4.001);
    expect(xs[0]).toBeLessThan(xs[xs.length - 1]);
    const p = run(new RigAnimator(), { lookX: 1, lookY: 0 }, 2);
    expect(p.headX + p.torsoX).toBeGreaterThan(5);
    expect(p.headRot).toBeGreaterThan(0);
    const q = run(new RigAnimator(), { lookX: 0, lookY: -1 }, 2);
    expect(q.irisY).toBeGreaterThan(0.5);
  });

  it('plays body gestures and holds a thinking tilt', () => {
    const a = new RigAnimator();
    run(a, {}, 1);
    let minY = 0;
    for (let i = 0; i < 30; i++)
      minY = Math.min(
        minY,
        a.step(1 / 60, 1 + i / 60, { ...base, gesture: { name: 'jump', id: 1 } }).bodyY,
      );
    expect(minY).toBeLessThan(-5);
    const t = run(new RigAnimator(), { thinking: true }, 3);
    expect(t.headRot).toBeLessThan(-2 * (Math.PI / 180));
    const sad = run(new RigAnimator(), { expression: 'sad' }, 3);
    expect(sad.shoulderL).toBeGreaterThan(2);
  });

  it('drives every head motion through the body (never a head over a frozen torso)', () => {
    const a = new RigAnimator(9);
    const steps: Partial<RigInput>[] = [];
    const push = (inp: Partial<RigInput>, secs: number) => {
      for (let i = 0; i < secs * 60; i++) steps.push(inp);
    };
    push({}, 6);
    push({ lookX: 1, lookY: 0.4 }, 2);
    push({ lookX: -1, lookY: -0.3 }, 2);
    push({ gesture: { name: 'nod', id: 1 } }, 1.5);
    push({ gesture: { name: 'wave', id: 2 } }, 1.5);
    push({ expression: 'happy' }, 2);
    push({ expression: 'sad' }, 2);
    push({ expression: 'angry' }, 2);
    push({ expression: 'surprised' }, 2);
    push({ thinking: true }, 2);
    push({ talking: true, mouth: 0.6 }, 2);
    let prev: RigPose | null = null;
    let still = 0;
    let worst = Infinity;
    steps.forEach((inp, i) => {
      const p = a.step(1 / 60, i / 60, { ...base, ...inp });
      if (prev) {
        const dHead =
          Math.abs(p.headRot - prev.headRot) * 120 +
          Math.abs(p.headX - prev.headX) +
          Math.abs(p.headY - prev.headY);
        const dBody =
          Math.abs(p.torsoRot - prev.torsoRot) * 725 +
          Math.abs(p.torsoX - prev.torsoX) +
          Math.abs(p.bodyY - prev.bodyY) +
          Math.abs(p.shoulderL - prev.shoulderL);
        if (dHead > 0.02 && dBody / dHead < worst) {
          worst = dBody / dHead;
        }
        still = dBody < 1e-4 ? still + 1 : 0;
        expect(still).toBeLessThan(6);
      }
      prev = p;
    });
    expect(worst).toBeGreaterThan(0.25);
  });

  it('noise is bounded and continuous', () => {
    let prev = noise1(0);
    for (let x = 0.01; x < 20; x += 0.01) {
      const v = noise1(x);
      expect(Math.abs(v)).toBeLessThan(1.2);
      expect(Math.abs(v - prev)).toBeLessThan(0.06);
      prev = v;
    }
  });

  it('opens the mouth while talking', () => {
    const p = run(new RigAnimator(), { talking: true, mouth: 0.8 }, 0.5);
    expect(p.mouthVariant).toBe('open');
    expect(p.mouthOpen).toBeGreaterThan(0.5);
    const q = run(new RigAnimator(), {}, 0.5);
    expect(q.mouthVariant).toBe('closed');
  });

  it('expressions change variants / tint', () => {
    expect(run(new RigAnimator(), { expression: 'happy' }).eyeVariant).toBe('happy');
    expect(run(new RigAnimator(), { expression: 'surprised' }).mouthVariant).toBe('o');
    const sad = run(new RigAnimator(), { expression: 'sad' }, 2);
    expect(sad.mouthVariant).toBe('frown');
    expect(sad.tint.a).toBeGreaterThan(0.05);
    expect(run(new RigAnimator(), { expression: 'angry' }, 2).angerMark).toBeGreaterThan(0.5);
  });

  it('hair lags behind head motion (secondary motion)', () => {
    const a = new RigAnimator();
    run(a, { lookX: -1 }, 1);
    const p = a.step(1 / 60, 1.01, { ...base, lookX: 1 });
    const p2 = run(a, { lookX: 1 }, 0.15, 1.02);
    expect(Math.abs(p2.hairRotL - p.hairRotL)).toBeGreaterThan(0.001);
  });

  it('idle has richer lean/breath travel than a frozen pose', () => {
    const a = new RigAnimator(11);
    const ps: RigPose[] = [];
    for (let i = 0; i < 60 * 12; i++) ps.push(a.step(1 / 60, i / 60, base));
    const torso = ps.map((p) => p.torsoRot);
    const tx = ps.map((p) => p.torsoX);
    const hy = ps.map((p) => p.headY);
    expect(Math.max(...torso) - Math.min(...torso)).toBeGreaterThan(0.012);
    expect(Math.max(...tx) - Math.min(...tx)).toBeGreaterThan(2.5);
    expect(Math.max(...hy) - Math.min(...hy)).toBeGreaterThan(1.2);
  });

  it('talking adds shoulder bounce and lean toward look', () => {
    const quiet = run(new RigAnimator(2), { lookX: 0.8 }, 2);
    const talk = run(new RigAnimator(2), { lookX: 0.8, talking: true, mouth: 0.7 }, 2);
    expect(talk.shoulderL).toBeLessThan(quiet.shoulderL + 0.5);
    expect(Math.abs(talk.torsoX)).toBeGreaterThan(Math.abs(quiet.torsoX) * 0.9);
  });

  it('plays expanded gestures (wave, shrug, look_around, shy, point, clap)', () => {
    for (const [name, check] of [
      ['wave', (p: RigPose) => Math.abs(p.armRotR) > 0.01 || p.bodyY < -0.5],
      ['shrug', (p: RigPose) => p.shoulderL < -1],
      ['look_around', (p: RigPose) => Math.abs(p.headRot) > 0.02],
      ['shy', (p: RigPose) => p.headRot < -0.02],
      ['point', (p: RigPose) => p.armRotR > 0.01],
      ['clap', (p: RigPose) => p.bodyY < -1 || p.shoulderL < -0.5],
      ['celebrate', (p: RigPose) => p.bodyY < -2],
    ] as const) {
      const a = new RigAnimator();
      run(a, {}, 0.5);
      let hit = false;
      for (let i = 0; i < 90; i++) {
        const p = a.step(1 / 60, 0.5 + i / 60, { ...base, gesture: { name, id: 1 } });
        if (check(p)) hit = true;
      }
      expect(hit).toBe(true);
    }
  });

  it('exposes browRaise and cheekSquash without forcing happy lids', () => {
    const happy = run(new RigAnimator(), { expression: 'happy' }, 2);
    expect(happy.cheekSquash).toBeGreaterThan(0.2);
    expect(happy.browRaise).toBeGreaterThanOrEqual(0);
    const n = run(new RigAnimator(), {}, 2);
    expect(n.eyeVariant).toBe('open');
  });
});

describe('sprite backend with rig', () => {
  const manifest: SpriteManifest = {
    id: 'rig',
    displayName: 'Rig',
    style: 'soft',
    license: 'MIT',
    author: 't',
    expressions: { neutral: 'neutral.png' },
    rig: { size: [10, 10], anchors: {}, layers: { body: [0, 0], head: [0, 0] } },
  };
  it('keeps emotion names and exposes talking/mouth', () => {
    const b = createSpriteBackend(manifest, '/x/');
    b.setExpression('angry');
    b.setTalking(true);
    b.setMouthOpen(0.7);
    b.update(0.1, 0.1);
    const s = b.snapshot();
    expect(s.expression).toBe('angry');
    expect(s.talking).toBe(true);
    expect(s.mouth).toBeGreaterThan(0.3);
    expect(b.capabilities().lipSync).toBe(true);
    b.setExpression('blink');
    b.update(0.05, 0.2);
    expect(b.snapshot().blinkOpacity).toBeGreaterThan(0);
  });
  it('routes motions to rig gestures and the thinking flag', () => {
    const b = createSpriteBackend(manifest, '/x/');
    expect(b.playMotion('wave')).toBe(true);
    const g1 = b.snapshot().gesture;
    expect(g1?.name).toBe('wave');
    b.playMotion('wave');
    expect(b.snapshot().gesture?.id).not.toBe(g1?.id);
    expect(b.playMotion('shrug')).toBe(true);
    expect(b.snapshot().gesture?.name).toBe('shrug');
    expect(b.playMotion('look_around')).toBe(true);
    expect(b.capabilities().motions).toContain('explain');
    expect(b.capabilities().motions).toContain('shy');
    b.playMotion('think-on');
    expect(b.snapshot().thinking).toBe(true);
    b.playMotion('think-off');
    expect(b.snapshot().thinking).toBe(false);
    // the rig blinks on its own: no backend auto blink
    for (let i = 0; i < 100; i++) b.update(0.1, i * 0.1);
    expect(b.snapshot().blinkOpacity).toBe(0);
  });
});
