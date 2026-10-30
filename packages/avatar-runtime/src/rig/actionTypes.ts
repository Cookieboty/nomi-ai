import { PARAM_INDEX } from './params';

/** Easing of the segment that ENDS at a key: l linear · i in · o out · io smooth · b back-out (overshoot) · s step. */
export type Ease = 'l' | 'i' | 'o' | 'io' | 'b' | 's';
export type Key = [t: number, v: number] | [t: number, v: number, ease: Ease];

export interface Track {
  /** parameter name (see params.ts) */
  p: string;
  k: Key[];
  /** additive sine on top of the keys: [amplitude, Hz, phase(rad)] — fades with the action weight */
  osc?: [amp: number, hz: number, phase?: number];
  /** the oscillation only runs inside [from, to] seconds of the action */
  oscWin?: [from: number, to: number];
}

export type ActionCategory =
  'greet' | 'agree' | 'think' | 'emotion' | 'celebrate' | 'work' | 'rest' | 'react' | 'idle';

/** 0 idle behaviour · 1 normal · 2 reaction (click, drop) · 3 task event (done / failed) */
export type Priority = 0 | 1 | 2 | 3;

export interface ActionDef {
  id: string;
  /** Chinese menu label */
  label: string;
  category: ActionCategory;
  /** seconds until the last key (one-shot) — the action then fades out */
  dur: number;
  /** keep the pose after `dur`: loop [loopFrom, dur] until released (or `maxHold` s) */
  hold?: boolean;
  loopFrom?: number;
  maxHold?: number;
  priority?: Priority;
  fadeIn?: number;
  fadeOut?: number;
  /** seconds before the same action may auto-play again (idle behaviours / spam guard) */
  cooldown?: number;
  tracks: Track[];
  /** one line: what triggers it in the app (docs + behaviour mapping) */
  trigger?: string;
  /** may be picked by the random idle behaviour scheduler */
  idle?: boolean;
}

export interface CompiledTrack {
  idx: number;
  t: Float32Array;
  v: Float32Array;
  e: Uint8Array;
  oscAmp: number;
  oscW: number;
  oscPh: number;
  oscFrom: number;
  oscTo: number;
  /** last segment used (monotonic cursor) */
  cur: number;
}

export interface CompiledAction {
  def: ActionDef;
  tracks: CompiledTrack[];
  fadeIn: number;
  fadeOut: number;
  priority: Priority;
}

const EASE_CODE: Record<Ease, number> = { l: 0, i: 1, o: 2, io: 3, b: 4, s: 5 };

export function compileAction(def: ActionDef): CompiledAction {
  const tracks: CompiledTrack[] = [];
  for (const tr of def.tracks) {
    const idx = PARAM_INDEX[tr.p];
    if (idx === undefined) throw new Error(`action ${def.id}: unknown param ${tr.p}`);
    const keys = [...tr.k].sort((a, b) => a[0] - b[0]);
    tracks.push({
      idx,
      t: Float32Array.from(keys.map((k) => k[0])),
      v: Float32Array.from(keys.map((k) => k[1])),
      e: Uint8Array.from(keys.map((k) => EASE_CODE[(k[2] as Ease | undefined) ?? 'io'])),
      oscAmp: tr.osc?.[0] ?? 0,
      oscW: (tr.osc?.[1] ?? 0) * Math.PI * 2,
      oscPh: tr.osc?.[2] ?? 0,
      oscFrom: tr.oscWin?.[0] ?? 0,
      oscTo: tr.oscWin?.[1] ?? Number.POSITIVE_INFINITY,
      cur: 0,
    });
  }
  return {
    def,
    tracks,
    fadeIn: def.fadeIn ?? 0.25,
    fadeOut: def.fadeOut ?? 0.3,
    priority: def.priority ?? 1,
  };
}

function ease(code: number, x: number): number {
  switch (code) {
    case 0:
      return x;
    case 1:
      return x * x;
    case 2:
      return 1 - (1 - x) * (1 - x);
    case 3:
      return x * x * (3 - 2 * x);
    case 4: {
      // back-out: ~6% overshoot — reads lively without rubber-limb snap
      const c1 = 1.12;
      const c3 = c1 + 1;
      const y = x - 1;
      return 1 + c3 * y * y * y + c1 * y * y;
    }
    default:
      return 0; // step: hold previous value until the next key
  }
}

/** Sample a compiled track at time `t` (no allocation). */
export function sampleTrack(tr: CompiledTrack, t: number): number {
  const n = tr.t.length;
  if (n === 0) return 0;
  if (t <= tr.t[0]) return tr.v[0];
  if (t >= tr.t[n - 1]) return tr.v[n - 1];
  let i = tr.cur;
  if (i >= n - 1 || t < tr.t[i]) i = 0;
  while (i < n - 2 && t >= tr.t[i + 1]) i++;
  tr.cur = i;
  const t0 = tr.t[i];
  const t1 = tr.t[i + 1];
  const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
  const code = tr.e[i + 1];
  if (code === 5) return tr.v[i];
  const k = ease(code, u);
  return tr.v[i] + (tr.v[i + 1] - tr.v[i]) * k;
}
