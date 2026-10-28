/**
 * 渲染进程守卫：本 bundle 的主入口面向角色渲染进程（DOM + WebGL），
 * 不能在纯 node 脚本 / Electron 主进程 crash 时载入。
 *
 * 单测通过 `skipInTest: true` 旁路（依赖 VITEST 环境变量）。
 */
export interface AssertRendererProcessOptions {
  /** 允许旁路（仅测试）。运行期请**不要**打开。 */
  skipInTest?: boolean;
}

interface ElectronProcessLike {
  type?: 'browser' | 'renderer' | 'worker' | 'utility';
  versions?: NodeJS.ProcessVersions;
}

export function assertRendererProcess(opts: AssertRendererProcessOptions = {}): void {
  if (opts.skipInTest && typeof process !== 'undefined' && process.env?.VITEST) return;

  const hasWindow = typeof globalThis !== 'undefined' && 'window' in globalThis;
  const hasDocument = typeof globalThis !== 'undefined' && 'document' in globalThis;

  if (!hasWindow || !hasDocument) {
    throw new Error(
      '[@nomi-ai/bundle-ig-mascot] must be loaded inside a renderer (window/document required)',
    );
  }

  if (typeof process !== 'undefined') {
    const proc = process as unknown as ElectronProcessLike;
    if (proc.type === 'browser') {
      throw new Error(
        '[@nomi-ai/bundle-ig-mascot] cannot be loaded in Electron main process ' +
          "(process.type === 'browser').",
      );
    }
  }
}
