/**
 * 编程助手编排对外入口（docs/design/cli-plugin-architecture.md §5.4 / R5）。
 * 实现在 `cli/harness/Orchestrator.ts`；本文件保持原有导入路径与公开 API 不变。
 */
export {
  CliHarnessService,
  HarnessOrchestrator,
  HarnessStoppedError,
  MAIN_TAB_ID,
  DELEGATED_PERMISSION_TIMEOUT_MS,
  materializeGeneratedImages,
  rewriteGeneratedImageLinks,
  resolveHarnessBin,
  type HarnessGateway,
  type HarnessPorts,
  type HarnessOfficialAccounts,
  type HarnessExternalPlugins,
  type AccountBackend,
  type HarnessTabFinished,
} from './harness/Orchestrator';
