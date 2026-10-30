/**
 * SdkContext —— AIClient 唯一依赖的 插件 ctx 子集，抽出便于 mock 与解耦。
 *
 * 之所以不直接依赖 `PluginContext`：
 * - 它包含 `on/emit/provide/config/logger`，其中 `on/emit` 的事件枚举是 `PluginEvent`
 *   —— 而 AIClient 需要把 插件事件桥接为业务 `AIClientEvent`；
 * - 只把 SDK 真正需要的 4 个方法暴露出去，可以在 P6 用 插件宿主 真实 ctx 直接 pass-through，
 *   在测试里则轻量 mock。
 */

import type { PluginEvent, HookHandler, PluginContext, ServiceKey } from '@nomi-ai/bundle-ig-base';

export interface SdkContext {
  inject<T>(key: ServiceKey<T>): T | undefined;
  on<TPayload = unknown, TResult = void>(
    event: PluginEvent,
    handler: HookHandler<TPayload, TResult>,
  ): () => void;
  emit<TPayload = unknown>(event: PluginEvent, payload: TPayload): void;
}

/** 从完整 `PluginContext` 收窄到 `SdkContext`。 */
export function toSdkContext(ctx: PluginContext): SdkContext {
  return {
    inject: (key) => ctx.inject(key),
    on: (evt, handler) => ctx.on(evt, handler),
    emit: (evt, payload) => ctx.emit(evt, payload),
  };
}
