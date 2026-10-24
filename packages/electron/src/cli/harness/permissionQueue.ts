/**
 * 权限审批队列辅助（含 PR3 ExitPlanMode → 「批准计划」）。
 * docs/design/cli-permission-modes.md §5。
 */
import type { HarnessEvent, HarnessPermissionMode } from '@nomi-ai/cli-sdk';

/** Claude / Grok / ACP 退出计划模式的工具名 */
const EXIT_PLAN_TOOLS = new Set([
  'ExitPlanMode',
  'exit_plan_mode',
  'exit-plan-mode',
  'exitPlanMode',
]);

/** 从权限摘要或工具名判断是否为「退出计划模式」请求 */
export function isExitPlanTool(nameOrSummary: string | undefined): boolean {
  if (!nameOrSummary) return false;
  const head = nameOrSummary.split(/[:\s]/, 1)[0]?.trim() ?? '';
  if (EXIT_PLAN_TOOLS.has(head)) return true;
  // summary 形如 "ExitPlanMode" 或 "ExitPlanMode: …"
  const lower = head.toLowerCase().replace(/[_-]/g, '');
  return lower === 'exitplanmode';
}

/** 批准计划卡上的用户选择（设计默认：批准并自动改文件 / 批准并逐项确认 / 继续修改） */
export type ApprovePlanChoice = 'acceptEdits' | 'manual' | 'deny';

export function approvePlanMode(choice: ApprovePlanChoice): HarnessPermissionMode | null {
  if (choice === 'acceptEdits') return 'acceptEdits';
  if (choice === 'manual') return 'manual';
  return null;
}

/** 权限请求带上超时时间点：界面显示倒计时，与主进程的自动拒绝同一个时钟 */
export function withPermissionExpiry(ev: HarnessEvent, timeoutMs: number): HarnessEvent {
  if (ev.type !== 'permission' || ev.expiresAt !== undefined) return ev;
  return { ...ev, expiresAt: Date.now() + timeoutMs };
}

/**
 * 把普通权限事件标成「批准计划」（kind），供界面渲染三按钮卡。
 * 已带 kind 的事件不改。
 */
export function markApprovePlanIfExit(ev: HarnessEvent): HarnessEvent {
  if (ev.type !== 'permission') return ev;
  if (ev.kind === 'approve-plan' || ev.kind === 'tool') return ev;
  const name = ev.toolName ?? ev.summary;
  if (!isExitPlanTool(name)) return ev;
  return {
    ...ev,
    kind: 'approve-plan',
    ...(ev.toolName ? {} : { toolName: name.split(/[:\s]/, 1)[0] }),
  };
}

/** Codex / dsh / Grok：计划模式回合结束后的「按此方案执行」卡 id 前缀 */
export const EXECUTE_PLAN_ID_PREFIX = 'execute-plan:';

export function isExecutePlanId(id: string): boolean {
  return id.startsWith(EXECUTE_PLAN_ID_PREFIX);
}

/** 合成「按此方案执行」权限事件（非 CLI can_use_tool；主进程本地队列） */
export function executePlanEvent(
  turnKey: string,
  summary: string,
  timeoutMs: number,
): Extract<HarnessEvent, { type: 'permission' }> {
  return {
    type: 'permission',
    id: `${EXECUTE_PLAN_ID_PREFIX}${turnKey}`,
    summary,
    kind: 'approve-plan',
    toolName: 'execute_plan',
    expiresAt: Date.now() + timeoutMs,
  };
}

/** 批准计划后要发给 Claude 的跟进提示（Codex/dsh/Grok 点「按此方案执行」时用） */
export const EXECUTE_PLAN_FOLLOW_UP = '按上述计划实施';
