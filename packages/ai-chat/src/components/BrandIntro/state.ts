import { useSyncExternalStore } from 'react';

export type IntroPhase = 'idle' | 'drawing' | 'waiting' | 'docking' | 'revealing' | 'done';
type BootTask = 'nomi' | 'tabs' | 'sidebar';
interface IntroState {
  phase: IntroPhase;
  mode: 'onboarding' | 'app';
  target: HTMLElement | null;
  skipped: boolean;
  ready: boolean;
  pending: readonly BootTask[];
}
const INITIAL: IntroState = {
  phase: 'idle',
  mode: 'onboarding',
  target: null,
  skipped: false,
  ready: false,
  pending: [],
};
let state = INITIAL;
const listeners = new Set<() => void>();
const update = (patch: Partial<IntroState>) => {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
};
export const introActive = (phase: IntroPhase): boolean => phase !== 'idle' && phase !== 'done';
export const introHolding = (phase: IntroPhase): boolean =>
  phase === 'drawing' || phase === 'waiting' || phase === 'docking';
const nextPhase = (): IntroPhase =>
  state.mode === 'app'
    ? state.ready
      ? state.skipped
        ? 'done'
        : 'revealing'
      : 'waiting'
    : state.target
      ? state.skipped
        ? 'done'
        : 'docking'
      : 'waiting';

/** 本次窗口的视觉状态；任务只报告加载完成，不改变会话或引导配置。 */
export const startupBrandIntro = {
  getSnapshot: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  start(mode: IntroState['mode'] = 'onboarding') {
    if (state.phase !== 'idle') return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    update({
      mode,
      phase: reduced ? (mode === 'app' ? 'waiting' : 'done') : 'drawing',
      skipped: !!reduced,
      pending: mode === 'app' ? ['nomi', 'tabs', 'sidebar'] : [],
    });
  },
  showOnboarding() {
    if (introActive(state.phase)) update({ mode: 'onboarding', pending: [] });
  },
  taskStart(task: BootTask) {
    if (state.mode !== 'app' || !introActive(state.phase) || state.pending.includes(task)) return;
    update({
      pending: [...state.pending, task],
      ready: false,
      ...(state.phase === 'revealing' ? { phase: 'waiting' as const } : {}),
    });
  },
  taskDone(task: BootTask) {
    if (!introActive(state.phase) || !state.pending.includes(task)) return;
    update({ pending: state.pending.filter((key) => key !== task) });
  },
  appReady() {
    if (state.mode !== 'app' || !introActive(state.phase)) return;
    update({ ready: true });
    if (state.phase === 'waiting') update({ phase: nextPhase() });
  },
  setTarget(target: HTMLElement | null) {
    if (target === state.target) return;
    update({ target });
    if (state.mode === 'onboarding' && state.phase === 'waiting') update({ phase: nextPhase() });
  },
  drawn() {
    if (state.phase === 'drawing') update({ phase: nextPhase() });
  },
  reveal() {
    if (state.phase === 'docking') update({ phase: 'revealing' });
  },
  complete() {
    if (introActive(state.phase)) update({ phase: 'done' });
  },
  skip() {
    if (!introActive(state.phase)) return;
    update({ skipped: true });
    update({ phase: nextPhase() });
  },
  cancel() {
    update({ phase: 'done' });
  },
  resetForTest() {
    state = INITIAL;
    listeners.forEach((fn) => fn());
  },
};
export const useBrandIntro = () =>
  useSyncExternalStore(
    startupBrandIntro.subscribe,
    startupBrandIntro.getSnapshot,
    startupBrandIntro.getSnapshot,
  );
