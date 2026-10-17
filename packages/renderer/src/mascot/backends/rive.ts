import type { MascotBackend, MascotCapabilities, MotionOptions } from '../MascotBackend';

/** Motions exposed by the high-fidelity Rive scene. */
export const RIVE_MOTIONS = [
  'wave',
  'hello',
  'celebrate',
  'cheer',
] as const;

/** Backwards-compatible name used by the existing renderer tests and commands. */
export const RIVE_POC_MOTIONS = RIVE_MOTIONS;

export const RIVE_EXPRESSIONS = [
  'neutral',
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
] as const;

/** the slice of Rive's ViewModelInstance we use (keeps the backend unit-testable without wasm) */
export interface RiveTriggerHost {
  trigger(name: string): { trigger(): void } | null;
}

/**
 * Rive backend over the high-fidelity state machine. Expressions and mouth actions
 * are trigger-based because the scene deliberately keeps the source rasters locked.
 * Look-at is left to the layered renderer until a vector eye rig is authored.
 */
export function createRiveBackend(host: () => RiveTriggerHost | null | undefined): MascotBackend {
  let expression = 'neutral';
  let talking = false;
  let mouthOpen = false;
  const fire = (name: string): boolean => {
    const t = host()?.trigger(name);
    if (!t) return false;
    t.trigger();
    return true;
  };
  return {
    kind: 'rive',
    setExpression(name, weight = 1) {
      if (weight <= 0) return;
      const next = RIVE_EXPRESSIONS.includes(name as (typeof RIVE_EXPRESSIONS)[number])
        ? name
        : 'neutral';
      if (next === expression) return;
      expression = next;
      fire(`expr-${next}`);
    },
    setMouthOpen(value) {
      const next = Number.isFinite(value) && value > 0.22;
      if (next === mouthOpen) return;
      mouthOpen = next;
      fire(next ? 'mouth-open' : 'mouth-close');
    },
    lookAt() {
      /* The supplied eye plates are raster-locked; keep gaze on the layered rig. */
    },
    blink() {
      fire('expr-relaxed');
    },
    playMotion(name: string, _opts?: MotionOptions): boolean {
      const id =
        name === 'random'
          ? RIVE_POC_MOTIONS[Math.floor(Math.random() * RIVE_POC_MOTIONS.length)]
          : name;
      if (!(RIVE_POC_MOTIONS as readonly string[]).includes(id)) return false;
      return fire(id);
    },
    setTalking(value) {
      if (value === talking) return;
      talking = value;
      fire(value ? 'talking' : 'mouth-close');
    },
    capabilities(): MascotCapabilities {
      return {
        expressions: [...RIVE_EXPRESSIONS],
        lipSync: true,
        lookAt: false,
        blink: true,
        motions: [...RIVE_MOTIONS],
      };
    },
    dispose() {
      /* the canvas component owns the Rive instance */
    },
  };
}
