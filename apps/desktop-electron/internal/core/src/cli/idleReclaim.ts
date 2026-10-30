/**
 * 长驻 CLI 进程的空闲回收策略（纯函数，便于单测；执行动作在 CliHarnessService）。
 *
 * 只有 Claude 有跨轮长驻进程（stdin stream-json）；Codex / dsh / Grok 每轮一个进程，轮次结束即退出。
 * 一个长驻进程在「没有进行中的轮次、没有待处理的权限请求、已有可续接的 CLI 会话」且
 * 空闲超过阈值时回收；下一条消息会带 `--resume <sessionId>` 重新拉起。
 */

/** 默认空闲 30 分钟后回收 */
export const DEFAULT_IDLE_RECLAIM_MS = 30 * 60_000;
/** 阈值下限，防止配置失误导致刚回完就被回收 */
export const MIN_IDLE_RECLAIM_MS = 1_000;
/** 巡检间隔上限 */
export const MAX_SWEEP_MS = 60_000;

/**
 * 解析空闲回收阈值（毫秒）。优先级：构造参数 > 环境变量 `NOMI_HARNESS_IDLE_MS` > 默认值。
 * `0` 表示关闭回收；非数字 / 负数回落到默认值；其余按下限取整。
 */
export function resolveIdleReclaimMs(override: number | undefined, envValue: string | undefined) {
  const raw =
    override ?? (envValue === undefined || envValue.trim() === '' ? NaN : Number(envValue));
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_IDLE_RECLAIM_MS;
  if (raw === 0) return 0;
  return Math.max(MIN_IDLE_RECLAIM_MS, Math.floor(raw));
}

/** 巡检间隔：阈值的 1/4，夹在 [250ms, 60s] */
export function sweepIntervalMs(idleMs: number): number {
  return Math.min(MAX_SWEEP_MS, Math.max(250, Math.floor(idleMs / 4)));
}

export interface IdleCandidate {
  id: string;
  /** 最近一次活动（拉起 / 发送 / 收到输出）的时间戳 */
  lastActivityAt: number;
  /** 有进行中的轮次 */
  turnActive: boolean;
  /** 有未答复的权限请求 */
  permissionPending: boolean;
  /** 标签处于 running / queued */
  tabBusy: boolean;
  /** 已有可 --resume 的 CLI 会话（否则回收会丢上下文） */
  resumable: boolean;
  /** 还有后台子代理 / 后台任务在跑（回收会把它们一起杀掉） */
  backgroundActive?: boolean;
}

/** 返回应当回收的标签 id */
export function pickIdle(
  candidates: readonly IdleCandidate[],
  now: number,
  idleMs: number,
): string[] {
  if (idleMs <= 0) return [];
  return candidates
    .filter(
      (c) =>
        !c.turnActive &&
        !c.permissionPending &&
        !c.tabBusy &&
        !c.backgroundActive &&
        c.resumable &&
        now - c.lastActivityAt >= idleMs,
    )
    .map((c) => c.id);
}
