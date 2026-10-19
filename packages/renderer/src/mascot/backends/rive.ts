import type { MascotBackend, MascotCapabilities, MotionOptions } from '../MascotBackend';

/** Native clips authored in the high-fidelity Rive scene. */
export const RIVE_NATIVE_MOTIONS = [
  'wave',
  'hello',
  'celebrate',
  'cheer',
  'fist_pump',
  'fist',
  'nod',
  'flinch',
  'poke',
  'shake',
  'clap',
  'think',
  'work',
  'typing',
  'bow',
  'salute',
  'prayer',
  'ok',
  'explain',
  'eureka',
  'puzzled',
  'look_around',
  'look_lr',
  'peek',
  'heart',
  'blow_kiss',
  'shy',
  'apology',
  'surprise',
  'inhale',
  'smug',
  'aggrieved',
  'tears',
  'angry',
  'cold_sweat',
  'daze',
  'thumbs_up',
  'peace',
  'hop',
  'blink',
  'tongue',
  'yawn',
  'stretch',
  'squat',
] as const;

/**
 * Shared AI / interaction vocabulary. Rive keeps one visual source of truth,
 * so commands without a dedicated clip intentionally route to the closest
 * authored gesture instead of disappearing at the backend boundary.
 */
export const RIVE_MOTION_ALIASES: Record<string, (typeof RIVE_NATIVE_MOTIONS)[number]> = {
  greet: 'hello',
  shake_head: 'shake',
  pray: 'prayer',
  ok_hand: 'ok',
  wink: 'blink',
  cover_face: 'flinch',
  sorry: 'apology',
  sigh: 'inhale',
  cute: 'hello',
  goodnight: 'bow',
  listen: 'think',
  peek_note: 'peek',
  interact: 'hello',
  crouch: 'squat',
};

/** All accepted names shown to the motion menu and exposed to AI callers. */
export const RIVE_MOTIONS = [...RIVE_NATIVE_MOTIONS, ...Object.keys(RIVE_MOTION_ALIASES)] as const;

/** Backwards-compatible name used by existing renderer tests and commands. */
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
 * are trigger-based. The happy expression is backed by the full-body rig's
 * authored smile overlay; look-at remains on the layered renderer until a vector
 * eye rig is authored.
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
      if (next === 'happy') fire('smile');
      else fire(`expr-${next}`);
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
      const requested =
        name === 'random'
          ? RIVE_POC_MOTIONS[Math.floor(Math.random() * RIVE_POC_MOTIONS.length)]
          : name;
      const id = RIVE_MOTION_ALIASES[requested] ?? requested;
      if (!(RIVE_NATIVE_MOTIONS as readonly string[]).includes(id)) return false;
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
