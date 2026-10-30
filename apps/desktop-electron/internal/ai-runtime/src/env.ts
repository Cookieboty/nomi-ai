/**
 * 进程守卫：ai-runtime 只能在宿主的主进程（Node）里加载，不能进渲染进程 / 页面。
 *
 * 内核（`@nomi-ai/core`）是纯 Node，Electron 主进程与无界面宿主（`@nomi-ai/host-node`）都能跑它
 * （docs/design/core-host-decoupling.md §3.2、§7.1），所以这里不再要求 `process.versions.electron`：
 * - Electron：`process.type` 必须是 `'browser'`（主进程）；`'renderer'` / `'worker'` 等拒绝；
 * - 纯 Node：没有 `process.type`，但不能在有 `window` / `document` 的环境里（页面打包进来）。
 *
 * `skipInTest` 仅供 vitest 桩测试内使用；生产运行时**必须**保持 false。
 */
export interface AssertMainProcessOptions {
  skipInTest?: boolean;
}

export function assertMainProcess(opts: AssertMainProcessOptions = {}): void {
  if (opts.skipInTest && process.env.VITEST) return;

  const proc = process as NodeJS.Process & { type?: string };
  if (proc.type !== undefined && proc.type !== 'browser') {
    throw new Error(
      '[@nomi-ai/ai-runtime] must be loaded in the host main process ' +
        `(process.type === '${proc.type}').`,
    );
  }
  const g = globalThis as { window?: unknown; document?: unknown };
  if (proc.type === undefined && (g.window !== undefined || g.document !== undefined)) {
    throw new Error('[@nomi-ai/ai-runtime] must not be loaded in a page (window/document found).');
  }
}
