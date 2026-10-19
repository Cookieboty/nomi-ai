/**
 * 启动后默认显示哪个界面（设置 key：`startup.defaultView`）的纯决策逻辑，不依赖 electron，便于单测。
 *
 * - `mascot`（默认）：保持历史行为——启动后只出现看板娘，要进主界面点看板娘的「AI 对话」。
 * - `main`：启动后直接打开软件主界面（对话窗口）并聚焦；看板娘仍然照常创建（定时任务 / 提醒 /
 *   编程助手进度等都靠它播报），只是以「不抢焦点」的方式出现。
 */
export const STARTUP_VIEWS = ['mascot', 'main'] as const;
export type StartupView = (typeof STARTUP_VIEWS)[number];
export const DEFAULT_STARTUP_VIEW: StartupView = 'mascot';

/** 未知 / 缺失 / 被改坏的值一律回落到默认（老用户升级、手改文件都安全） */
export function normalizeStartupView(v: unknown): StartupView {
  return (STARTUP_VIEWS as readonly string[]).includes(v as string)
    ? (v as StartupView)
    : DEFAULT_STARTUP_VIEW;
}

export interface StartupPlanInput {
  defaultView: StartupView;
  /** 首次启动引导尚未完成（引导本来就显示在主界面里） */
  onboardingPending: boolean;
  /** 由系统登录项 / 开机自启拉起 */
  openedAtLogin: boolean;
}

export interface StartupPlan {
  /** 启动时是否打开主界面 */
  openMain: boolean;
  /** 打开主界面前等待的毫秒数（0 = 看板娘窗口创建完成后立即打开） */
  delayMs: number;
  /** 主界面是否抢占焦点；开机自启时为 false，避免一登录就弹出大窗口盖住别的工作 */
  activateMain: boolean;
  /** 看板娘窗口是否抢占焦点；主界面优先时为 false，保证最后获得焦点的是主界面 */
  activateMascot: boolean;
}

/** 首次引导延迟：等看板娘窗口先出来，再打开引导（她会在引导中打招呼） */
export const ONBOARDING_OPEN_DELAY_MS = 1500;

export function planStartup(i: StartupPlanInput): StartupPlan {
  // 首次引导优先，与设置值无关：引导里才选启动方式，此时一定是默认（看板娘）行为
  if (i.onboardingPending) {
    return {
      openMain: true,
      delayMs: ONBOARDING_OPEN_DELAY_MS,
      activateMain: true,
      activateMascot: true,
    };
  }
  if (i.defaultView === 'main') {
    return { openMain: true, delayMs: 0, activateMain: !i.openedAtLogin, activateMascot: false };
  }
  return { openMain: false, delayMs: 0, activateMain: true, activateMascot: true };
}

/**
 * 重新激活已运行的实例（第二实例启动 / macOS 点 Dock 图标 / Windows 点托盘图标）时，是否应该把主界面带到前台。
 * `mascot` 模式保持历史行为（只聚焦已有窗口）。
 */
export function shouldRaiseMainOnReactivate(defaultView: StartupView): boolean {
  return defaultView === 'main';
}
