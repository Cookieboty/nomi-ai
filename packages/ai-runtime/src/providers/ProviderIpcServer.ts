/**
 * ProviderIpcServer —— `ai:providers:*` IPC 通道（面板 / 工具栏 / 托盘共用）。
 *
 * 安全约定：
 * - 返回值只有 ProviderView / ProviderState（掩码 key），**不回传明文 / 密文**；
 * - 明文 key 只在 `upsert` / `addKey` / `rotateKey` / `testDraft` 的入参中单向进入主进程；
 * - 不记录入参（避免把 key 打进日志），错误信息经 `redactSecrets` 处理；
 * - store 任意变更后向所有窗口广播 `ai:providers:changed`（只含 ProviderState）。
 */
import type { IpcAdapter, IpcInvokeEvent } from '../IpcAdapter';
import type { RuntimeLogger } from '../logger';

import { redactSecrets, type ProviderService } from './ProviderService';

/**
 * 渲染进程还在用的通道：预设（添加第三方供应商时选）、状态与切换（环境变量供应商的过渡期，
 * 网关里没有分配时由旧存储路由）。供应商增删改、任务路由、Key 管理已由统一网关（ai:gateway:*）取代。
 */
export const PROVIDER_CHANNELS = ['presets', 'meta', 'state', 'setActive'] as const;

export const PROVIDERS_CHANGED_EVENT = 'ai:providers:changed';

export interface ProviderIpcServerOptions {
  adapter: IpcAdapter;
  service: ProviderService;
  logger?: RuntimeLogger;
  isSenderAllowed?: (event: IpcInvokeEvent) => boolean;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`参数 ${name} 必须是字符串`);
  return v;
};

export class ProviderIpcServer {
  private readonly registered: string[] = [];
  private unsubscribe?: () => void;

  constructor(private readonly opts: ProviderIpcServerOptions) {}

  get channels(): readonly string[] {
    return this.registered;
  }

  start(): void {
    if (this.registered.length > 0) return;
    const s = this.opts.service;
    const handlers: Record<(typeof PROVIDER_CHANNELS)[number], (...a: unknown[]) => unknown> = {
      presets: () => s.presets(),
      meta: () => s.meta(),
      state: () => s.state(),
      setActive: (id, model) =>
        s.setActive(
          id === null || id === undefined ? null : str(id, 'id'),
          model === undefined || model === null ? undefined : str(model, 'model'),
        ),
    };
    for (const name of PROVIDER_CHANNELS) {
      const ch = `ai:providers:${name}`;
      this.opts.adapter.handle(ch, async (event, ...args) => {
        if (this.opts.isSenderAllowed && !this.opts.isSenderAllowed(event)) {
          throw new Error(`[ai-runtime] sender ${event.senderId} is not allowed for ${ch}`);
        }
        try {
          const out = await handlers[name](...args);
          return out;
        } catch (err) {
          const msg = redactSecrets(err instanceof Error ? err.message : String(err));
          this.opts.logger?.warn(`${ch} failed: ${msg}`);
          // 故意不挂 cause：原始错误可能含未脱敏的 key 片段
          // eslint-disable-next-line preserve-caught-error
          throw new Error(msg);
        }
      });
      this.registered.push(ch);
    }
    // 任何入口（IPC / 托盘 / 工具栏）改动 store 都会广播
    this.unsubscribe = s.onChange(() => this.broadcast());
    this.opts.logger?.info(`provider ipc ready · ${this.registered.length} channels`);
  }

  /** 状态变化通知（托盘切换等非 IPC 入口也应调用）。 */
  broadcast(): void {
    const state = this.opts.service.state();
    for (const wc of this.opts.adapter.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send(PROVIDERS_CHANGED_EVENT, state);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const ch of this.registered.splice(0)) this.opts.adapter.removeHandler(ch);
  }
}
