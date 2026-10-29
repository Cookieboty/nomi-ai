/**
 * @nomi-ai/ai-runtime · 主入口
 *
 * 顶部即断言在宿主主进程（Electron 主进程或纯 Node，不能是渲染进程 / 页面，见 `env.ts`）；
 * vitest（happy-dom 等页面环境）下跳过。
 */

import { AIRuntimeService, type AIRuntimeServiceOptions } from './AIRuntimeService';
import { assertMainProcess } from './env';

if (!process.env.VITEST) {
  assertMainProcess();
}

export * from './env';
export * from './logger';
export * from './observability';
export * from './ObservabilityBridge';
export * from './AIRuntimeService';
export * from './AiSdkBooter';
export * from './ai-sdk/AiSdkLlmProvider';
export * from './ai-sdk/mapTools';
export * from './ai-sdk/AiSdkLLMProvidersPlugin';
export * from './ai-sdk/AiSdkMcpPlugin';
export * from './ai-sdk/mcpBridge';
export * from './providers';
export * from './IgPluginHost';
export * from './igPlugins';
export * from './NoopLifecycle';
export * from './IpcAdapter';
export * from './AiContractRouter';

/**
 * `runtime` 单例（旧入口）。内核按实例创建 `new AIRuntimeService(...)`（一个进程可以有多个内核）；
 * 这个单例只留给还按旧方式用的调用方。用法：
 * ```ts
 * import { runtime, createAiSdkBooter } from '@nomi-ai/ai-runtime';
 * // lifecycle 由宿主提供（Electron：lifecycle 端口的 onBeforeQuit）
 * await runtime.configure({ booter: createAiSdkBooter(), lifecycle: { onBeforeQuit } })
 *              .start('companion', { home });
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
