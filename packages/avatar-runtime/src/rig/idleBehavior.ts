import { ACTIONS } from './actions';

/**
 * Random idle behaviours for the 2D mascot: after some quiet time she looks around, hums, yawns,
 * stretches … Pure and seedable (tests); the canvas calls `update` once per frame.
 *
 * - never while busy (an action is running), speaking, or under reduced motion
 * - night hours (23–6) prefer yawn / sleepy behaviours
 * - per-action cooldowns live in the ActionManager (`cooldown` of each ActionDef)
 */
export interface IdleContext {
  /** ms since the last user / AI activity */
  idleMs: number;
  /** an action is playing or queued */
  busy: boolean;
  /** local hour 0..23 */
  hour: number;
  reduced: boolean;
}

const POOL_DAY = ACTIONS.filter((a) => a.idle && !['yawn', 'stretch'].includes(a.id)).map(
  (a) => a.id,
);

/** Pick the idle behaviour for a context (null = nothing yet). Exported for tests. */
export function pickIdleAction(c: IdleContext, rand: () => number): string | null {
  if (c.reduced || c.busy || c.idleMs < 18_000) return null;
  const night = c.hour >= 23 || c.hour < 6;
  if (night && c.idleMs > 40_000) return rand() < 0.55 ? 'yawn' : 'goodnight';
  if (c.idleMs > 150_000 && rand() < 0.4) return 'stretch';
  if (c.idleMs > 90_000 && rand() < 0.35) return 'yawn';
  return POOL_DAY[Math.floor(rand() * POOL_DAY.length)] ?? null;
}

export class IdleBehavior {
  private nextAt = 0;
  constructor(private readonly rand: () => number = Math.random) {}

  /** Returns an action id when one should start now. */
  update(nowMs: number, c: IdleContext): string | null {
    if (c.reduced || c.busy || c.idleMs < 18_000) {
      // restart the wait whenever activity resumes
      this.nextAt = 0;
      return null;
    }
    if (this.nextAt === 0) this.nextAt = nowMs + 4_000 + this.rand() * 14_000;
    if (nowMs < this.nextAt) return null;
    this.nextAt = nowMs + 25_000 + this.rand() * 45_000;
    return pickIdleAction(c, this.rand);
  }
}
