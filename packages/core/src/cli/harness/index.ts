/**
 * 编程助手编排层模块（docs/design/cli-plugin-architecture.md §5.4 / R5）。
 * 对外入口仍是 `cli/CliHarnessService.ts`。
 */
export * from './liveTypes';
export {
  withPermissionExpiry,
  markApprovePlanIfExit,
  isExitPlanTool,
  approvePlanMode,
  executePlanEvent,
  isExecutePlanId,
  EXECUTE_PLAN_FOLLOW_UP,
  EXECUTE_PLAN_ID_PREFIX,
  type ApprovePlanChoice,
} from './permissionQueue';
export {
  HarnessOrchestrator,
  CliHarnessService,
  initCliHarnessService,
  getCliHarnessService,
  materializeGeneratedImages,
  rewriteGeneratedImageLinks,
  resolveHarnessBin,
} from './Orchestrator';
