/**
 * AIRuntimeService —— 主进程 AI 运行时门面。
 *
 * 责任：
 * 1. 通过注入的 `Booter` 完成 `boot(profile, { home })`，拿到 `PluginContext`
 *    （生产默认 `createAiSdkBooter` / IgPluginHost）。
 * 2. 用 `toSdkContext` 收窄成 `SdkContext` 后构造 [`AIClient`](file:///../../ai-sdk/src/AIClient.ts)。
 * 3. 挂接 `AppLifecycle.onBeforeQuit`，在应用退出前调用 `stop()`。
 * 4. 打印一次 `AI runtime booted (<profile>)`，用于运维定位。
 *
 * 设计注解：
 * - `Booter` 与 `AppLifecycle` 都以 **DI 参数** 传入，避免把 Electron / 具体 harness 硬耦合到本类，
 *   测试里可以完全 mock 掉，保证在纯 Node 环境跑通 vitest。
 * - `runtime` 单例只是**便利导出**；仍然允许业务方 `new AIRuntimeService(...)` 自建实例
 *   （多窗口 / 多 profile 场景）。
 */

import { AIClient, toSdkContext, type AIClientOptions } from '@nomi-ai/ai-sdk';
import type { PluginContext } from '@nomi-ai/bundle-ig-base';

import type { RuntimeLogger } from './logger';
import { ConsoleRuntimeLogger } from './logger';

export interface StartOptions {
  /** 运行时根目录（应用路径） */
  home: string;
  /** 传给 AIClient 的可选选项（logger/config） */
  clientOptions?: AIClientOptions;
}

export interface Booter {
  /**
   * 完成宿主装配并返回 PluginContext。生产默认 `createAiSdkBooter`（IgPluginHost +
   * Vercel AI SDK providers）；测试注入 fake。
   */
  boot(profile: string, opts: StartOptions): Promise<PluginContext>;
  /** 可选：释放运行时资源。 */
  dispose?(): Promise<void> | void;
}

export interface AppLifecycle {
  onBeforeQuit(fn: () => void | Promise<void>): () => void;
}

export interface AIRuntimeServiceOptions {
  booter: Booter;
  lifecycle?: AppLifecycle;
  logger?: RuntimeLogger;
}

export class RuntimeNotStartedError extends Error {
  constructor() {
    super('[ai-runtime] client 未初始化，请先 await runtime.start(profile, { home })');
    this.name = 'RuntimeNotStartedError';
  }
}

export class RuntimeAlreadyStartedError extends Error {
  constructor(profile: string) {
    super(`[ai-runtime] runtime 已经以 profile='${profile}' 启动，请先 stop() 后再 start()`);
    this.name = 'RuntimeAlreadyStartedError';
  }
}

export class AIRuntimeService {
  private _client: AIClient | undefined;
  private _profile: string | undefined;
  private _ctx: PluginContext | undefined;
  private lifecycleOff: (() => void) | undefined;
  private readonly logger: RuntimeLogger;

  constructor(private readonly opts: AIRuntimeServiceOptions) {
    this.logger = opts.logger ?? ConsoleRuntimeLogger;
  }

  get client(): AIClient {
    if (!this._client) throw new RuntimeNotStartedError();
    return this._client;
  }

  get profile(): string | undefined {
    return this._profile;
  }

  get isStarted(): boolean {
    return Boolean(this._client);
  }

  async start(profile: string, startOpts: StartOptions): Promise<AIClient> {
    if (this._client) throw new RuntimeAlreadyStartedError(this._profile ?? '<unknown>');

    const ctx = await this.opts.booter.boot(profile, startOpts);
    const sdkCtx = toSdkContext(ctx);
    const client = new AIClient(sdkCtx, startOpts.clientOptions ?? {});

    this._ctx = ctx;
    this._client = client;
    this._profile = profile;

    if (this.opts.lifecycle) {
      this.lifecycleOff = this.opts.lifecycle.onBeforeQuit(() => this.stop());
    }

    this.logger.info(`AI runtime booted (${profile})`, { home: startOpts.home });
    return client;
  }

  async stop(): Promise<void> {
    if (!this._client) return;
    try {
      await this._client.dispose();
    } catch (err) {
      this.logger.warn('[ai-runtime] AIClient.dispose threw', err);
    }
    try {
      await this.opts.booter.dispose?.();
    } catch (err) {
      this.logger.warn('[ai-runtime] booter.dispose threw', err);
    }
    this.lifecycleOff?.();
    this.lifecycleOff = undefined;
    this._client = undefined;
    this._ctx = undefined;
    this._profile = undefined;
    this.logger.info('[ai-runtime] stopped');
  }
}
