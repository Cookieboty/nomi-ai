/**
 * @nomi-ai/ai-runtime · 主入口
 *
 * 顶部即断言主进程；测试通过 `VITEST` 环境变量自动旁路（`env.ts` 内部处理）。
 * 注：断言只在**真实生产**执行；测试导入 `env` 内 `assertElectronMainProcess({ skipInTest: true })`
 * 需要显式开关，所以主入口这里在 test 下也直接跳过，避免 test bootstrap 崩溃。
 */

import { AIRuntimeService, type AIRuntimeServiceOptions } from './AIRuntimeService';
import { assertElectronMainProcess } from './env';

if (!process.env.VITEST) {
  assertElectronMainProcess();
}

export * from './env';
export * from './logger';
export * from './observability';
export * from './ObservabilityBridge';
export * from './AIRuntimeService';
export * from './AiSdkBooter';
export * from './ai-sdk/AiSdkLlmProvider';
export * from './ai-sdk/mapTools';
export * from './ai-sdk/toolCaller';
export * from './ai-sdk/AiSdkLLMProvidersPlugin';
export * from './ai-sdk/AiSdkMcpPlugin';
export * from './ai-sdk/mcpBridge';
export * from './providers';
export * from './IgPluginHost';
export * from './igPlugins';
export * from './ElectronLifecycle';
export * from './IpcAdapter';
export * from './AiContractRouter';

/**
 * `runtime` 单例。业务方在 Electron 主进程中：
 * ```ts
 * import { runtime, createAiSdkBooter, createElectronLifecycle } from '@nomi-ai/ai-runtime';
 * await runtime.configure({ booter: createAiSdkBooter(), lifecycle: createElectronLifecycle() })
 *              .start('waifu', { home: app.getAppPath() });
 * ```
 * 允许多次 configure 但只能在未启动状态。
 */
class RuntimeSingleton {
  private inner: AIRuntimeService | undefined;

  configure(opts: AIRuntimeServiceOptions): AIRuntimeService {
    if (this.inner?.isStarted) {
      throw new Error('[ai-runtime] runtime already started; call stop() before reconfiguring');
    }
    this.inner = new AIRuntimeService(opts);
    return this.inner;
  }

  get service(): AIRuntimeService {
    if (!this.inner)
      throw new Error('[ai-runtime] runtime not configured; call runtime.configure(...) first');
    return this.inner;
  }

  start(profile: string, startOpts: Parameters<AIRuntimeService['start']>[1]) {
    return this.service.start(profile, startOpts);
  }

  stop() {
    return this.inner?.stop();
  }

  get client() {
    return this.service.client;
  }
}

export const runtime = new RuntimeSingleton();
