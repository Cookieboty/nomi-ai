import { describe, expect, it } from 'vitest';

import { RigAnimator, type RigInput, type RigPose } from '../src/layeredRig';
import { IDX, ParamBag } from '../src/rig/params';
import { PoseGate } from '../src/rig/poseGate';

const base: RigInput = {
  expression: 'neutral',
  mouth: 0,
  talking: false,
  blink: 0,
  lookX: 0,
  lookY: 0,
};

function settledPose(): RigPose {
  const a = new RigAnimator();
  let p = a.step(1 / 60, 0, { ...base, reducedMotion: true });
  for (let i = 1; i < 240; i++) p = a.step(1 / 60, i / 60, { ...base, reducedMotion: true });
  return { ...p, tint: { ...p.tint } };
}

describe('PoseGate', () => {
  it('paints the first frame, skips sub-pixel changes, paints visible ones', () => {
    const g = new PoseGate();
    const p = settledPose();
    expect(g.shouldPaint(p, 1, 'k')).toBe(true);
    expect(g.shouldPaint({ ...p }, 1, 'k')).toBe(false);
    // 0.1 rig px at scale 1 → 0.1 device px: below the threshold
    expect(g.shouldPaint({ ...p, bodyY: p.bodyY + 0.1 }, 1, 'k')).toBe(false);
    // accumulates against the last *painted* pose, never drifts
    expect(g.shouldPaint({ ...p, bodyY: p.bodyY + 0.3 }, 1, 'k')).toBe(true);
    expect(g.shouldPaint({ ...p, bodyY: p.bodyY + 0.3 }, 1, 'k')).toBe(false);
    // the same 0.1 rig px is visible when the rig is drawn 4x larger
    expect(g.shouldPaint({ ...p, bodyY: p.bodyY + 0.4 }, 4, 'k')).toBe(true);
    expect(g.shouldPaint({ ...p, bodyY: p.bodyY + 0.4, lidClose: 0.5 }, 4, 'k')).toBe(true);
    expect(
      g.shouldPaint({ ...p, bodyY: p.bodyY + 0.4, lidClose: 0.5, mouthVariant: 'o' }, 4, 'k'),
    ).toBe(true);
  });

  it('repaints on canvas changes and after invalidate', () => {
    const g = new PoseGate();
    const p = settledPose();
    g.shouldPaint(p, 1, 'a');
    expect(g.shouldPaint(p, 1, 'b')).toBe(true);
    expect(g.shouldPaint(p, 1, 'b')).toBe(false);
    g.invalidate();
    expect(g.shouldPaint(p, 1, 'b')).toBe(true);
  });

  it('time only matters while an effect is drawn; action params are compared', () => {
    const g = new PoseGate();
    const p = settledPose();
    const bag = new ParamBag();
    g.shouldPaint({ ...p, ext: bag, time: 1, reduced: false }, 1, 'k');
    expect(g.shouldPaint({ ...p, ext: bag, time: 2, reduced: false }, 1, 'k')).toBe(false);
    bag.v[IDX.fxHeart] = 0.5;
    expect(g.shouldPaint({ ...p, ext: bag, time: 2, reduced: false }, 1, 'k')).toBe(true);
    expect(g.shouldPaint({ ...p, ext: bag, time: 2.016, reduced: false }, 1, 'k')).toBe(true);
    expect(g.shouldPaint({ ...p, ext: null, time: 2.016, reduced: false }, 1, 'k')).toBe(true);
  });
});

describe('RigAnimator.quickMotionNear', () => {
  it('flags the moments around a blink and is quiet in between', () => {
    const a = new RigAnimator(3);
    const flags: boolean[] = [];
    for (let i = 0; i < 60 * 12; i++) {
      const t = i / 60;
      a.step(1 / 60, t, { ...base, reducedMotion: true });
      flags.push(a.quickMotionNear(t));
    }
    // reduced motion still blinks: some frames are flagged, most are not
    const on = flags.filter(Boolean).length;
    expect(on).toBeGreaterThan(0);
    expect(on).toBeLessThan(flags.length);
  });
});
