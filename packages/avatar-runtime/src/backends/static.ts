import type { MascotBackend, MascotCapabilities, MotionOptions } from '../MascotBackend';

/**
 * Static image mascot backend — motions / lip-sync / lookAt are no-ops.
 * Interaction (drag window, hitboxes → bubble text) stays on the canvas host.
 */
export function createStaticBackend(): MascotBackend {
  return {
    kind: 'static',
    setExpression() {},
    setMouthOpen() {},
    lookAt() {},
    blink() {},
    playMotion(_name: string, _opts?: MotionOptions) {
      return false;
    },
    setTalking() {},
    capabilities(): MascotCapabilities {
      return {
        expressions: ['neutral'],
        lipSync: false,
        lookAt: false,
        blink: false,
        motions: [],
      };
    },
    dispose() {},
  };
}
