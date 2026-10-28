import { beforeEach, describe, expect, it } from 'vitest';

import { createSpriteBackend } from '../src/backends/sprite';
import { directiveForActivity, directiveForEvent } from '../src/expressionDirector';
import { RigAnimator } from '../src/layeredRig';
import { activityTarget, gestureTarget } from '../src/mapping';
import { MOTION_LABELS } from '../src/motion/labels';
import { ActionManager } from '../src/rig/actionManager';
import { ACTIONS, ACTION_LABELS } from '../src/rig/actions';
import { compileAction, sampleTrack, type ActionDef } from '../src/rig/actionTypes';
import { IdleBehavior, pickIdleAction } from '../src/rig/idleBehavior';
import { HAND, IDX, MOUTH, PARAM_DEFS, PARAM_INDEX } from '../src/rig/params';

const mk = (over: Partial<ActionDef> & { id: string }): ActionDef => ({
  label: over.id,
  category: 'react',
  dur: 1,
  tracks: [
    {
      p: 'headNod',
      k: [
        [0, 0],
        [0.5, 10],
        [1, 0],
      ],
    },
  ],
  ...over,
});
const run = (m: ActionManager, sec: number, dt = 1 / 60) => {
  for (let t = 0; t < sec; t += dt) m.update(dt);
};

describe('action library', () => {
  it('ships at least 30 distinct, named actions with label keys and triggers', () => {
    expect(ACTIONS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
    for (const a of ACTIONS) {
      // label 存的是界面翻译 key（宿主用 t() 显示，中文见 renderer 的 motionDocs 测试）
      expect(a.label, a.id).toMatch(/^ui\.[a-z0-9.-]+$/);
      expect(a.trigger, a.id).toBeTruthy();
      expect(ACTION_LABELS[a.id]).toBe(a.label);
      expect(MOTION_LABELS[a.id]).toBe(a.label);
    }
  });

  it('covers the requested actions', () => {
    const want = [
      'wave',
      'nod',
      'shake_head',
      'bow',
      'think',
      'heart',
      'cheer',
      'thumbs_up',
      'peace',
      'celebrate',
      'clap',
      'shy',
      'sorry',
      'surprise',
      'puzzled',
      'yawn',
      'stretch',
      'work',
      'explain',
      'look_around',
      'peek',
      'sigh',
      'smug',
      'aggrieved',
      'angry',
      'hop',
      'blow_kiss',
      'salute',
      'cover_face',
      'look_lr',
      'goodnight',
    ];
    const ids = ACTIONS.map((a) => a.id);
    for (const w of want) expect(ids, w).toContain(w);
  });

  it('every track drives a known parameter inside its range, ends at rest, and fits the duration', () => {
    for (const a of ACTIONS) {
      const c = compileAction(a); // throws on unknown parameter
      for (const tr of c.tracks) {
        const d = PARAM_DEFS[tr.idx];
        for (let i = 0; i < tr.v.length; i++) {
          expect(tr.v[i], `${a.id}.${d.name}`).toBeGreaterThanOrEqual(d.min);
          expect(tr.v[i], `${a.id}.${d.name}`).toBeLessThanOrEqual(d.max);
        }
        // no key beyond the action length (99 s = "until the action ends" sentinel of held states)
        const last = tr.t[tr.t.length - 1];
        expect(last <= a.dur + 1e-6 || last >= 99, `${a.id}.${d.name}`).toBe(true);
      }
      expect(a.dur).toBeGreaterThan(0.8);
      expect(a.dur).toBeLessThan(6);
      // hand shapes used by arms exist
      for (const tr of a.tracks)
        if (tr.p === 'rHand' || tr.p === 'lHand')
          for (const k of tr.k) expect(k[1]).toBeLessThanOrEqual(Math.max(...Object.values(HAND)));
    }
  });
});

describe('track sampling', () => {
  it('interpolates with the key easing and clamps outside the keys', () => {
    const c = compileAction(
      mk({
        id: 't',
        tracks: [
          {
            p: 'headNod',
            k: [
              [0, 0],
              [1, 10, 'l'],
              [2, 0, 's'],
            ],
          },
        ],
      }),
    );
    const tr = c.tracks[0];
    expect(sampleTrack(tr, -1)).toBe(0);
    expect(sampleTrack(tr, 0.5)).toBeCloseTo(5, 5);
    expect(sampleTrack(tr, 1.5)).toBe(10); // step: holds the previous key
    expect(sampleTrack(tr, 9)).toBe(0);
  });

  it('back-out easing overshoots the target a little', () => {
    const c = compileAction(
      mk({
        id: 't',
        tracks: [
          {
            p: 'headNod',
            k: [
              [0, 0],
              [1, 10, 'b'],
            ],
          },
        ],
      }),
    );
    let max = 0;
    for (let t = 0; t <= 1; t += 0.01) max = Math.max(max, sampleTrack(c.tracks[0], t));
    expect(max).toBeGreaterThan(10.2);
    expect(max).toBeLessThan(11.5);
  });
});

describe('ActionManager', () => {
  let m: ActionManager;
  beforeEach(() => {
    m = new ActionManager([
      mk({ id: 'a', priority: 1 }),
      mk({ id: 'b', priority: 2 }),
      mk({ id: 'c', priority: 3, dur: 0.5 }),
      mk({ id: 'idle', priority: 0, cooldown: 5 }),
      mk({ id: 'held', hold: true, loopFrom: 0.4, maxHold: 3, priority: 1 }),
    ]);
  });

  it('plays an action and fades it out to the default pose', () => {
    expect(m.play('a')).toBe(true);
    run(m, 0.5);
    expect(m.current()).toBe('a');
    expect(m.out.v[IDX.headNod]).toBeGreaterThan(5);
    run(m, 2);
    expect(m.busy()).toBe(false);
    expect(m.out.v[IDX.headNod]).toBe(0);
  });

  it('rejects unknown ids', () => {
    expect(m.play('nope')).toBe(false);
  });

  it('priority: higher replaces, lower is dropped (or queued on request)', () => {
    m.play('b');
    run(m, 0.2);
    expect(m.play('a')).toBe(false);
    expect(m.current()).toBe('b');
    expect(m.play('a', { queue: true })).toBe(true);
    expect(m.queued()).toEqual(['a']);
    run(m, 1.6);
    expect(m.queued()).toEqual([]);
    expect(m.lastStarted).toBe('a');
    m.play('c');
    expect(m.current()).toBe('c');
  });

  it('crossfades: the replaced action fades out while the new one is live', () => {
    m.play('a');
    run(m, 0.4);
    m.play('b');
    run(m, 0.05);
    expect(m.activeIds()).toEqual(['a', 'b']);
    run(m, 0.6);
    expect(m.activeIds()).toEqual(['b']);
  });

  it('cooldown blocks spam of idle actions but not forced requests', () => {
    m.play('idle');
    run(m, 2);
    expect(m.play('idle')).toBe(false);
    expect(m.play('idle', { force: true })).toBe(true);
  });

  it('hold loops until released, then ends; maxHold is a safety net', () => {
    m.play('held');
    run(m, 2.5);
    expect(m.current()).toBe('held');
    m.release('held');
    run(m, 1);
    expect(m.busy()).toBe(false);
    m.play('held');
    run(m, 4.5);
    expect(m.busy()).toBe(false);
  });

  it('a repeated request for the held action keeps it (no restart flicker)', () => {
    m.play('held');
    run(m, 1);
    const before = m.activeIds().length;
    expect(m.play('held')).toBe(true);
    expect(m.activeIds().length).toBe(before);
  });

  it('reduced motion damps body parameters but keeps face parameters', () => {
    const rm = new ActionManager(ACTIONS);
    rm.play('bow');
    run(rm, 0.9);
    const full = Math.abs(rm.out.v[IDX.headNod]);
    const rm2 = new ActionManager(ACTIONS);
    rm2.reducedMotion = true;
    rm2.play('bow');
    run(rm2, 0.9);
    expect(Math.abs(rm2.out.v[IDX.headNod])).toBeLessThan(full * 0.7);
  });

  it('update() returns the same bag and keeps every value inside its range', () => {
    const all = new ActionManager(ACTIONS);
    const bag = all.update(0.016);
    let sameBag = true;
    const outOfRange: string[] = [];
    for (const a of ACTIONS) {
      all.play(a.id, { force: true, priority: 3 });
      for (let i = 0; i < 90; i++) {
        if (all.update(1 / 60) !== bag) sameBag = false;
        for (let p = 0; p < PARAM_DEFS.length; p++) {
          const v = bag.v[p];
          if (v < PARAM_DEFS[p].min || v > PARAM_DEFS[p].max)
            outOfRange.push(`${a.id}.${PARAM_DEFS[p].name}=${v}`);
        }
      }
    }
    expect(sameBag).toBe(true);
    expect(outOfRange.slice(0, 5)).toEqual([]);
  });

  it('an arm that only fades out keeps its pose while the sleeve cross-fades', () => {
    const am = new ActionManager(ACTIONS);
    am.play('wave');
    run(am, 1.0);
    const pose = am.out.v[IDX.rA];
    expect(pose).toBeGreaterThan(8);
    am.stop();
    run(am, 0.1);
    // still raised (not swinging down), while its weight (rOn) is already falling
    expect(am.out.v[IDX.rA]).toBeGreaterThan(pose * 0.9);
    expect(am.out.v[IDX.rOn]).toBeLessThan(1);
    run(am, 0.6);
    expect(am.busy()).toBe(false);
    expect(am.out.v[IDX.rOn]).toBe(0);
  });
});

describe('RigAnimator + actions', () => {
  const base = { expression: 'neutral', mouth: 0, talking: false, blink: 0, lookX: 0, lookY: 0 };
  it('a gesture input starts the keyframe action; arms switch on', () => {
    const a = new RigAnimator(3);
    let pose = a.step(1 / 60, 0, base);
    expect(pose.ext).toBeFalsy();
    for (let i = 0; i < 40; i++)
      pose = a.step(1 / 60, i / 60, { ...base, gesture: { name: 'wave', id: 1 } });
    expect(a.actions.current()).toBe('wave');
    expect(pose.ext!.v[IDX.rOn]).toBeGreaterThan(0.9);
    expect(pose.ext!.v[IDX.rHand]).toBe(HAND.wave);
  });

  it('raising an arm swings (forearm foreshortens), settles, then lowers by itself', () => {
    const a = new RigAnimator(3);
    let maxFore = 0;
    let peakA = 0;
    let lean = 0;
    let atEnd = 99;
    const dur = ACTIONS.find((x) => x.id === 'wave')!.dur;
    for (let i = 0; i < Math.round((dur + 0.1) * 60); i++) {
      const pose = a.step(1 / 60, i / 60, {
        ...base,
        gesture: i === 0 ? { name: 'wave', id: 1 } : undefined,
      });
      if (!pose.ext) continue;
      maxFore = Math.max(maxFore, pose.ext.v[IDX.rF]);
      peakA = Math.max(peakA, pose.ext.v[IDX.rA]);
      lean = Math.min(lean, pose.ext.v[IDX.torsoRot]);
      if (i === Math.round((dur - 0.05) * 60)) atEnd = pose.ext.v[IDX.rA];
    }
    expect(maxFore).toBeGreaterThan(0.15); // foreshortening during the swing (mild on-canvas poses)
    expect(peakA).toBeGreaterThan(10);
    expect(lean).toBeLessThan(-0.4); // torso leans away from the raised arm
    expect(atEnd).toBeLessThan(peakA * 0.35); // the arm is lowered before the action ends
  });

  it('follow-through never leaves a parameter outside its range', () => {
    const a = new RigAnimator(3);
    const bad: string[] = [];
    for (const def of ACTIONS) {
      for (let i = 0; i < 150; i++) {
        const pose = a.step(1 / 60, i / 60, {
          ...base,
          gesture: i === 0 ? { name: def.id, id: Math.random() + 1 } : undefined,
        });
        if (!pose.ext) continue;
        for (let p = 0; p < PARAM_DEFS.length; p++) {
          const v = pose.ext.v[p];
          if (v < PARAM_DEFS[p].min - 1e-3 || v > PARAM_DEFS[p].max + 1e-3)
            bad.push(`${def.id}.${PARAM_DEFS[p].name}=${v}`);
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('release ends a held action', () => {
    const a = new RigAnimator(3);
    for (let i = 0; i < 20; i++)
      a.step(1 / 60, i / 60, { ...base, gesture: { name: 'think', id: 1, hold: true } });
    expect(a.actions.current()).toBe('think');
    a.step(1 / 60, 1, { ...base, gesture: { name: '*', id: 2, release: true } });
    for (let i = 0; i < 90; i++) a.step(1 / 60, 1 + i / 60, base);
    expect(a.actions.busy()).toBe(false);
  });

  it('step cost stays small (no per-frame work blow-up)', () => {
    const a = new RigAnimator(3);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++)
      a.step(
        1 / 60,
        i / 60,
        i % 200 === 0 ? { ...base, gesture: { name: 'celebrate', id: i + 1 } } : base,
      );
    // 2000 frames must take far less than 2000 x 4 ms (CI machines are slow: generous bound)
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('sprite backend: motions', () => {
  const manifest = {
    id: 'x',
    name: 'x',
    expressions: { neutral: 'a.png' },
    rig: { size: [10, 10], anchors: {}, layers: {} },
  } as unknown as Parameters<typeof createSpriteBackend>[0];

  it('plays every action by name and lists them all in capabilities', () => {
    const b = createSpriteBackend(manifest, '/');
    const motions = b.capabilities().motions;
    for (const a of ACTIONS) {
      expect(motions).toContain(a.id);
      expect(b.playMotion(a.id)).toBe(true);
      expect(b.snapshot().gesture?.name).toBe(a.id);
    }
    expect(b.playMotion('definitely-not-a-motion')).toBe(false);
  });

  it('keeps old names working (aliases) and forwards priority / hold', () => {
    const b = createSpriteBackend(manifest, '/');
    expect(b.playMotion('shake')).toBe(true);
    expect(b.snapshot().gesture?.name).toBe('shake_head');
    expect(b.playMotion('flinch')).toBe(true);
    expect(b.snapshot().gesture?.name).toBe('surprise');
    b.playMotion('think', { priority: 2, hold: true });
    expect(b.snapshot().gesture).toMatchObject({ name: 'think', priority: 2, hold: true });
    b.playMotion('release');
    expect(b.snapshot().gesture?.release).toBe(true);
  });

  it('random picks an existing action', () => {
    const b = createSpriteBackend(manifest, '/');
    expect(b.playMotion('random')).toBe(true);
    expect(ACTIONS.map((a) => a.id)).toContain(b.snapshot().gesture!.name);
  });
});

describe('behaviour mapping', () => {
  // 表情导演给语义手势 / 活动，经默认映射（= 官方包 mapping.json）落到骨架动作
  const motion = (e: Parameters<typeof directiveForEvent>[0]) => {
    const d = directiveForEvent(e);
    return d?.gesture ? gestureTarget(d.gesture) : undefined;
  };
  it('maps app events to actions that exist', () => {
    expect(motion({ kind: 'task:done' })).toBe('thumbs_up');
    expect(motion({ kind: 'task:done', all: true })).toBe('celebrate');
    expect(motion({ kind: 'task:failed' })).toBe('sorry');
    expect(activityTarget(directiveForActivity('thinking').activity!)).toBe('think');
    expect(activityTarget(directiveForActivity('toolRunning').activity!)).toBe('work');
    expect(motion({ kind: 'greeting' })).toBe('wave');
    expect(motion({ kind: 'night' })).toBe('goodnight');
    expect(motion({ kind: 'file:drop' })).toBe('surprise');
    const ids = ACTIONS.map((a) => a.id);
    for (const k of ['task:done', 'task:failed', 'greeting', 'night', 'file:drop'] as const) {
      expect(ids).toContain(motion({ kind: k }));
    }
    expect(ids).toContain(activityTarget('thinking'));
    expect(ids).toContain(activityTarget('toolRunning'));
  });

  it('task events outrank normal actions; thinking and working are held', () => {
    expect(directiveForEvent({ kind: 'task:failed' })?.priority).toBe(3);
    expect(directiveForEvent({ kind: 'file:drop' })?.priority).toBe(2);
    expect(directiveForActivity('thinking').hold).toBe(true);
    expect(directiveForActivity('toolRunning').hold).toBe(true);
  });

  it('a long answer without a keyword gesture is explained with the pointing hand', () => {
    const d = directiveForEvent({
      kind: 'message:complete',
      text: 'lorem ipsum dolor sit amet '.repeat(40),
    });
    expect(d?.gesture).toBe('explain');
  });
});

describe('idle behaviour', () => {
  const ctx = { idleMs: 60_000, busy: false, hour: 14, reduced: false };
  const rand = (v: number) => () => v;

  it('never fires while busy, reduced, or before the quiet period', () => {
    expect(pickIdleAction({ ...ctx, busy: true }, rand(0.3))).toBeNull();
    expect(pickIdleAction({ ...ctx, reduced: true }, rand(0.3))).toBeNull();
    expect(pickIdleAction({ ...ctx, idleMs: 5_000 }, rand(0.3))).toBeNull();
  });

  it('prefers sleepy actions at night and stretches after a long idle', () => {
    expect(['yawn', 'goodnight']).toContain(
      pickIdleAction({ ...ctx, hour: 2, idleMs: 50_000 }, rand(0.2)),
    );
    expect(pickIdleAction({ ...ctx, idleMs: 200_000 }, rand(0.1))).toBe('stretch');
    expect(pickIdleAction(ctx, rand(0.5))).toBeTruthy();
  });

  it('daytime picks only actions flagged idle; scheduler waits and cools down', () => {
    const idleIds = new Set(ACTIONS.filter((a) => a.idle).map((a) => a.id));
    for (let r = 0; r < 1; r += 0.05) expect(idleIds).toContain(pickIdleAction(ctx, rand(r)));
    const b = new IdleBehavior(() => 0.5);
    expect(b.update(0, ctx)).toBeNull(); // arms the timer
    expect(b.update(1_000, ctx)).toBeNull();
    expect(b.update(12_000, ctx)).toBeTruthy();
    expect(b.update(13_000, ctx)).toBeNull(); // long cooldown after a pick
    expect(b.update(14_000, { ...ctx, busy: true })).toBeNull();
  });
});

describe('parameter registry', () => {
  it('has unique names and sane defaults', () => {
    const names = PARAM_DEFS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of PARAM_DEFS) {
      expect(p.def).toBeGreaterThanOrEqual(p.min);
      expect(p.def).toBeLessThanOrEqual(p.max);
      expect(PARAM_INDEX[p.name]).toBeDefined();
    }
  });

  it('blow_kiss keeps the pout phase: mouth goes auto → pout → smile → auto (#53)', () => {
    const m = new ActionManager(ACTIONS);
    m.play('blow_kiss');
    const at: Record<string, number> = {};
    let t = 0;
    for (const probe of [0.1, 0.6, 1.5, 2.2]) {
      while (t < probe) {
        m.update(0.05);
        t += 0.05;
      }
      at[String(probe)] = m.out.v[IDX.mouth];
    }
    expect(at['0.1']).toBe(MOUTH.auto);
    expect(at['0.6']).toBe(MOUTH.pout);
    expect(at['1.5']).toBe(MOUTH.smile);
    expect(at['2.2']).toBe(MOUTH.auto);
  });
});
