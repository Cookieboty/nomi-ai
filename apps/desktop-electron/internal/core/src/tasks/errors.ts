/**
 * 任务错误码（docs/design/persistent-tasks.md §5.2；依据 persistent-tasks-references.md §2.3、§2.9）。
 *
 * 只有瞬时错误可重试：HTTP 408 / 429 / 5xx、连接被拒 / 重置 / 超时、执行者进程意外退出。
 * Go 版：apps/desktop-go/internal/core/tasks/errors.go，表内容一致。
 */

export const TASK_ERROR_CODES = {
  /** 上游 HTTP 408 / 429 / 5xx */
  upstream_transient: { retryable: true },
  /** 连接被拒、重置、超时 */
  network: { retryable: true },
  /** 执行者进程意外退出或心跳丢失 */
  executor_crashed: { retryable: true },
  /** 超过每次执行的时长上限 */
  timed_out: { retryable: false },
  /** 执行者报告失败 */
  executor_failed: { retryable: false },
  /** 引用的供应商 / Key / 账号变了、点名的编程助手不可用（§8.7、§7.3）：不重试，停下来问用户 */
  config_changed: { retryable: false, ask: true },
  /** 授权不足或被拒 */
  grant_denied: { retryable: false },
  /** 预算用完且用户没批准继续 */
  budget_denied: { retryable: false },
  /** 用户放弃核对（§10.3） */
  reconcile_abandoned: { retryable: false },
  /** 准备执行环境失败（建 worktree 等） */
  prepare_failed: { retryable: false },
} as const;

export type TaskErrorCode = keyof typeof TASK_ERROR_CODES;

/** 要人处理的错误（配置变了）：执行失败后任务停到「等你处理」，用户确认后重跑，不悄悄换配置 */
export function asksUser(code: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(TASK_ERROR_CODES, code) &&
    (TASK_ERROR_CODES[code as TaskErrorCode] as { ask?: boolean }).ask === true
  );
}

/** 未知错误码按不可重试处理 */
export function isRetryable(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(TASK_ERROR_CODES, code)
    ? TASK_ERROR_CODES[code as TaskErrorCode].retryable
    : false;
}

/** 瞬时错误最多重试次数（Budget.maxRetries 默认值） */
export const DEFAULT_MAX_RETRIES = 3;

/** 重复任务连续失败多少次自动暂停 */
export const AUTO_PAUSE_AFTER_FAILURES = 3;

/** 重试退避：2 秒起翻倍，封顶 60 秒。attempt 从 1 开始 */
export function retryBackoffMs(attempt: number): number {
  return Math.min(2000 * 2 ** Math.max(0, attempt - 1), 60_000);
}
