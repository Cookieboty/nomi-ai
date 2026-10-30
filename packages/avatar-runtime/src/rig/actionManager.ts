import {
  type ActionDef,
  type CompiledAction,
  type Priority,
  compileAction,
  sampleTrack,
} from './actionTypes';
import { PARAM_COUNT, PARAM_DEFS, PARAM_INDEX, ParamBag } from './params';

/** 1 = right-arm parameter, 2 = left-arm parameter, 0 = other (frozen while an arm fades out) */
const ARM_SIDE = new Uint8Array(PARAM_COUNT);
for (const n of ['rA', 'rE', 'rW', 'rHand']) ARM_SIDE[PARAM_INDEX[n]] = 1;
for (const n of ['lA', 'lE', 'lW', 'lHand']) ARM_SIDE[PARAM_INDEX[n]] = 2;
const R_ON = PARAM_INDEX.rOn;
const L_ON = PARAM_INDEX.lOn;

export interface PlayOptions {
  /** override the action priority */
  priority?: Priority;
  /** queue (instead of drop) when a higher-priority action is running */
  queue?: boolean;
  /** hold the end pose until released (only for actions that declare `hold`) */
  hold?: boolean;
  /** skip cooldown check (explicit user / AI request) */
  force?: boolean;
}

interface Instance {
  a: CompiledAction;
  /** pose time (wraps while holding) */
  t: number;
  /** seconds since the action started */
  age: number;
  w: number;
  /** fading out */
  out: boolean;
  released: boolean;
  hold: boolean;
  priority: Priority;
  seq: number;
}

interface Pending {
  id: string;
  opts: PlayOptions;
  expires: number;
}

const MAX_ACTIVE = 4;
const MAX_QUEUE = 4;
const QUEUE_TTL = 6;

/**
 * Runs actions (keyframe tracks) on top of the idle layer.
 *
 * - Several actions may be alive while one fades in and another fades out (crossfade).
 * - Priority: a request of >= priority replaces the running action (it fades out); a lower one is
 *   queued (opt-in) or dropped. Queue is short-lived and de-duplicated.
 * - Output is a ParamBag: continuous = default + Σ w·(value − default); discrete = highest weight.
 * - `update()` allocates nothing.
 */
export class ActionManager {
  readonly out = new ParamBag();
  private lib = new Map<string, CompiledAction>();
  private active: Instance[] = [];
  private queue: Pending[] = [];
  private cooldownUntil = new Map<string, number>();
  private now = 0;
  private seq = 0;
  private bestW = new Float32Array(PARAM_COUNT);
  reducedMotion = false;
  /** last started id (for tests / UI) */
  lastStarted: string | null = null;

  constructor(defs: readonly ActionDef[] = []) {
    for (const d of defs) this.register(d);
  }

  register(def: ActionDef): void {
    this.lib.set(def.id, compileAction(def));
  }

  has(id: string): boolean {
    return this.lib.has(id);
  }
  ids(): string[] {
    return [...this.lib.keys()];
  }
  def(id: string): ActionDef | undefined {
    return this.lib.get(id)?.def;
  }

  /** ids currently alive (running or fading) */
  activeIds(): string[] {
    return this.active.map((i) => i.a.def.id);
  }
  /** id of the leading (newest, not fading out) action */
  current(): string | null {
    for (let i = this.active.length - 1; i >= 0; i--)
      if (!this.active[i].out) return this.active[i].a.def.id;
    return null;
  }
  busy(): boolean {
    return this.active.length > 0;
  }
  queued(): string[] {
    return this.queue.map((q) => q.id);
  }

  /** Start an action. Returns true when it started now or was queued. */
  play(id: string, opts: PlayOptions = {}): boolean {
    const a = this.lib.get(id);
    if (!a) return false;
    const prio = opts.priority ?? a.priority;
    if (!opts.force) {
      const cd = this.cooldownUntil.get(id);
      if (cd !== undefined && this.now < cd) return false;
    }
    const lead = this.leader();
    // already holding this very action (e.g. repeated "thinking" events): keep it, refresh the timer
    if (lead && lead.a.def.id === id && lead.hold && !lead.released) {
      lead.age = 0;
      return true;
    }
    if (lead && lead.priority > prio) {
      if (opts.queue) this.enqueue(id, opts);
      return !!opts.queue;
    }
    this.start(a, prio, !!opts.hold || (!!a.def.hold && opts.hold !== false));
    return true;
  }

  /** End a held action gracefully (fade out). */
  release(id?: string): void {
    for (const i of this.active) {
      if (!id || i.a.def.id === id) {
        // a held pose fades out right away; a plain one-shot simply finishes
        if (i.hold && !i.released) i.out = true;
        i.released = true;
        i.hold = false;
      }
    }
  }

  /** Fade out everything and clear the queue. */
  stop(): void {
    this.queue.length = 0;
    for (const i of this.active) {
      i.out = true;
      i.hold = false;
    }
  }

  private leader(): Instance | null {
    for (let i = this.active.length - 1; i >= 0; i--)
      if (!this.active[i].out) return this.active[i];
    return null;
  }

  private enqueue(id: string, opts: PlayOptions) {
    const dup = this.queue.findIndex((q) => q.id === id);
    if (dup >= 0) this.queue.splice(dup, 1);
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push({ id, opts, expires: this.now + QUEUE_TTL });
  }

  private start(a: CompiledAction, priority: Priority, hold: boolean) {
    // replace: everything running fades out (crossfade into the new one)
    for (const i of this.active) {
      i.out = true;
      i.hold = false;
    }
    // same action restarted: drop the old instance quickly instead of stacking
    if (this.active.length >= MAX_ACTIVE) this.active.shift();
    for (const t of a.tracks) t.cur = 0;
    this.active.push({
      a,
      t: 0,
      age: 0,
      w: 0,
      out: false,
      released: false,
      hold,
      priority,
      seq: ++this.seq,
    });
    this.lastStarted = a.def.id;
  }

  /** Advance by dt seconds and return the parameter bag (same object every call). */
  update(dt: number): ParamBag {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.now += dt;
    const rm = this.reducedMotion;
    // advance instances
    for (let n = this.active.length - 1; n >= 0; n--) {
      const i = this.active[n];
      const d = i.a.def;
      i.t += dt;
      i.age += dt;
      if (!i.out) {
        if (i.t >= d.dur) {
          if (i.hold && !i.released && i.age < (d.maxHold ?? 60)) {
            const lf = Math.min(d.loopFrom ?? Math.max(0, d.dur - 1), d.dur - 0.05);
            i.t = lf + ((i.t - d.dur) % (d.dur - lf));
          } else {
            i.out = true;
          }
        }
        i.w = Math.min(1, i.w + (i.a.fadeIn > 0 ? dt / i.a.fadeIn : 1));
      } else {
        i.w = Math.max(0, i.w - (i.a.fadeOut > 0 ? dt / i.a.fadeOut : 1));
        if (i.w <= 0) {
          this.cooldownUntil.set(d.id, this.now + (d.cooldown ?? 0));
          this.active.splice(n, 1);
        }
      }
    }

    // queued request starts when nothing blocks it
    if (this.queue.length) {
      const lead = this.leader();
      for (let q = 0; q < this.queue.length; q++) {
        const p = this.queue[q];
        if (this.now > p.expires) {
          this.queue.splice(q--, 1);
          continue;
        }
        const a = this.lib.get(p.id);
        if (!a) {
          this.queue.splice(q--, 1);
          continue;
        }
        const prio = p.opts.priority ?? a.priority;
        if (!lead || lead.priority <= prio || lead.age >= lead.a.def.dur) {
          this.queue.splice(q, 1);
          this.start(a, prio, !!p.opts.hold || !!a.def.hold);
          break;
        }
      }
    }

    // evaluate
    const v = this.out.v;
    const best = this.bestW;
    for (let p = 0; p < PARAM_COUNT; p++) {
      v[p] = PARAM_DEFS[p].def;
      best[p] = 0;
    }
    // an arm that is only fading out (no live action drives it) keeps its pose while its sleeve
    // cross-fades back to the rest arm, instead of swinging down through the canvas edge
    let rLive = false;
    let lLive = false;
    for (const inst of this.active) {
      if (inst.out) continue;
      for (const tr of inst.a.tracks) {
        if (tr.idx === R_ON) rLive = true;
        else if (tr.idx === L_ON) lLive = true;
      }
    }
    for (const inst of this.active) {
      const w0 = inst.w * inst.w * (3 - 2 * inst.w);
      if (w0 <= 0) continue;
      for (const tr of inst.a.tracks) {
        const pd = PARAM_DEFS[tr.idx];
        const side = ARM_SIDE[tr.idx];
        const w = inst.out && ((side === 1 && !rLive) || (side === 2 && !lLive)) ? 1 : w0;
        let val = sampleTrack(tr, inst.t);
        if (tr.oscAmp !== 0 && !rm && inst.t >= tr.oscFrom && inst.t <= tr.oscTo)
          val += tr.oscAmp * Math.sin(tr.oscW * inst.t + tr.oscPh);
        if (pd.discrete) {
          if (w >= 0.4 && w >= best[tr.idx]) {
            best[tr.idx] = w;
            v[tr.idx] = val;
          }
        } else {
          const k = rm ? (pd.rm ?? 1) : 1;
          v[tr.idx] += (val - pd.def) * w * k;
        }
      }
    }
    for (let p = 0; p < PARAM_COUNT; p++) {
      const pd = PARAM_DEFS[p];
      if (v[p] < pd.min) v[p] = pd.min;
      else if (v[p] > pd.max) v[p] = pd.max;
    }
    return this.out;
  }
}
