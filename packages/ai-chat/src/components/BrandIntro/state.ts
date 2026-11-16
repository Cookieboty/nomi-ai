import { useSyncExternalStore } from 'react';

export type IntroPhase = 'idle' | 'drawing' | 'waiting' | 'docking' | 'revealing' | 'done';
type BootTask = 'nomi' | 'tabs' | 'sidebar';
interface IntroState {
  phase: IntroPhase;
  mode: 'onboarding' | 'app';
  target: HTMLElement | null;
  skipped: boolean;
  ready: boolean;
  /** 已因总时限强制揭开：之后的加载任务不再把开屏拉回来。 */
  forced: boolean;
  pending: readonly BootTask[];
}
const INITIAL: IntroState = {
  phase: 'idle',
  mode: 'onboarding',
  target: null,
  skipped: false,
  ready: false,
  forced: false,
  pending: [],
};
/**
 * 开屏的兜底时限（毫秒）。正常启动会在数据到达、两帧排版后自然关闭；这些时限只防止某个
 * 请求或 WebView 的 Promise 永远不回导致一直停在开屏（2.3.15 回归）。
 * - TASK：单个启动任务（会话历史 / 标签 / 侧栏）最多等这么久就当作完成，界面先出来，数据在后台继续加载。
 * - HARD：从开屏开始算的总时限，约为绘制动画（1.4s 书写 + 0.45s 停留）之后再给 6 秒。
 */
export const STARTUP_TASK_TIMEOUT_MS = 5000;
export const STARTUP_HARD_TIMEOUT_MS = 8000;
/** 揭开淡出本应由组件在 180ms 后收尾；组件没能收尾时这里再兜一次。 */
const REVEAL_FALLBACK_MS = 600;

let state = INITIAL;
const listeners = new Set<() => void>();
const taskTimers = new Map<BootTask, ReturnType<typeof setTimeout>>();
let hardTimer: ReturnType<typeof setTimeout> | undefined;
let revealTimer: ReturnType<typeof setTimeout> | undefined;
const clearTimers = () => {
  taskTimers.forEach((id) => clearTimeout(id));
  taskTimers.clear();
  if (hardTimer !== undefined) clearTimeout(hardTimer);
  if (revealTimer !== undefined) clearTimeout(revealTimer);
  hardTimer = revealTimer = undefined;
};
const update = (patch: Partial<IntroState>) => {
  state = { ...state, ...patch };
  if (!introActive(state.phase)) clearTimers();
  listeners.forEach((fn) => fn());
};
const armTask = (task: BootTask) => {
  const prev = taskTimers.get(task);
  if (prev !== undefined) clearTimeout(prev);
  taskTimers.set(
    task,
    setTimeout(() => {
      taskTimers.delete(task);
      startupBrandIntro.taskDone(task);
    }, STARTUP_TASK_TIMEOUT_MS),
  );
};
/** 总时限到：不再等任何任务，直接揭开（app）或收起（引导），界面先可用。 */
const forceClose = () => {
  hardTimer = undefined;
  if (!introActive(state.phase)) return;
  if (state.mode !== 'app') {
    update({ phase: 'done' });
    return;
  }
  update({ pending: [], ready: true, forced: true });
  if (state.phase === 'waiting') update({ phase: 'revealing' });
  revealTimer = setTimeout(() => startupBrandIntro.complete(), REVEAL_FALLBACK_MS);
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
    if (!introActive(state.phase)) return;
    state.pending.forEach(armTask);
    hardTimer = setTimeout(forceClose, STARTUP_HARD_TIMEOUT_MS);
  },
  showOnboarding() {
    if (introActive(state.phase)) update({ mode: 'onboarding', pending: [] });
  },
  taskStart(task: BootTask) {
    if (
      state.mode !== 'app' ||
      state.forced ||
      !introActive(state.phase) ||
      state.pending.includes(task)
    )
      return;
    armTask(task);
    update({
      pending: [...state.pending, task],
      ready: false,
      ...(state.phase === 'revealing' ? { phase: 'waiting' as const } : {}),
    });
  },
  taskDone(task: BootTask) {
    const timer = taskTimers.get(task);
    if (timer !== undefined) clearTimeout(timer);
    taskTimers.delete(task);
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
    // 回访启动：用户点「跳过」就立刻收起，不再等数据；会话与侧栏在后台继续加载。
    if (state.mode === 'app') {
      update({ skipped: true, phase: 'done' });
      return;
    }
    update({ skipped: true });
    update({ phase: nextPhase() });
  },
  cancel() {
    update({ phase: 'done' });
  },
  resetForTest() {
    clearTimers();
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
