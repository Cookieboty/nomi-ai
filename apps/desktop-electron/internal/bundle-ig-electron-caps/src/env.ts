/**
 * 主进程守卫：本 bundle 使用的 API（safeStorage / clipboard / desktopCapturer / globalShortcut）
 * 只能在 Electron 主进程加载，渲染进程 / node 纯脚本都必须直接报错。
 */
export interface AssertMainProcessOptions {
  /** 允许旁路（仅测试）。运行期请**不要**打开。 */
  skipInTest?: boolean;
}

export function assertElectronMainProcess(opts: AssertMainProcessOptions = {}): void {
  if (opts.skipInTest && process.env.VITEST) return;

  const proc = process as NodeJS.Process & { type?: string; versions: NodeJS.ProcessVersions };
  const hasElectron = Boolean(proc.versions?.electron);
  const isMain = proc.type === 'browser' || proc.type === undefined;

  if (!hasElectron) {
    throw new Error(
      '[@nomi-ai/bundle-ig-electron-caps] must be loaded inside Electron main process ' +
        '(process.versions.electron is undefined).',
    );
  }
  if (!isMain) {
    throw new Error(
      '[@nomi-ai/bundle-ig-electron-caps] must be loaded inside Electron main process ' +
        `(process.type === '${proc.type}').`,
    );
  }
}
