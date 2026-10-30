/**
 * fakeSdkCtx —— 单测用的最小 SdkContext。
 *
 * 兼容与 [`fakeCtx`](file:///../../../bundle-ig-mascot/tests/helpers/fakeCtx.ts) 一致的风格：
 * - `provide` / `inject`：内存 Map，按 ServiceKey.key 定位
 * - `on` / `emit`：内部维护 handler set，`triggerEvent(evt, payload)` 同步串行触发
 */

import type { PluginEvent, HookContext, HookHandler, ServiceKey } from '@nomi-ai/bundle-ig-base';

import type { SdkContext } from '../../src/di/SdkContext';

export interface FakeSdkContext extends SdkContext {
  provide<T>(key: ServiceKey<T>, impl: T): void;
  emitted: Array<{ evt: PluginEvent; payload: unknown }>;
  triggerEvent<TPayload>(evt: PluginEvent, payload: TPayload): Promise<void>;
  disposeAll(): void;
}

interface HandlerEntry {
  handler: HookHandler<unknown, unknown>;
}

export function createFakeSdkCtx(): FakeSdkContext {
  const services = new Map<symbol, unknown>();
  const handlers = new Map<PluginEvent, Set<HandlerEntry>>();
  const emitted: FakeSdkContext['emitted'] = [];

  const ctx: FakeSdkContext = {
    emitted,
    provide<T>(key: ServiceKey<T>, impl: T) {
      services.set(key.key, impl);
    },
    inject<T>(key: ServiceKey<T>): T | undefined {
      return services.get(key.key) as T | undefined;
    },
    on<TPayload = unknown, TResult = void>(
      event: PluginEvent,
      handler: HookHandler<TPayload, TResult>,
    ) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      const entry: HandlerEntry = { handler: handler as HookHandler<unknown, unknown> };
      handlers.get(event)!.add(entry);
      return () => {
        handlers.get(event)?.delete(entry);
      };
    },
    emit<TPayload = unknown>(event: PluginEvent, payload: TPayload) {
      emitted.push({ evt: event, payload });
    },
    async triggerEvent<TPayload>(event: PluginEvent, payload: TPayload) {
      const set = handlers.get(event);
      if (!set) return;
      for (const { handler } of set) {
        const hookCtx: HookContext<TPayload> = {
          payload,
          reject: (reason, code) => {
            throw Object.assign(new Error(reason), { code });
          },
          log: () => {},
        };
        await handler(hookCtx as unknown as HookContext<unknown>);
      }
    },
    disposeAll() {
      handlers.clear();
    },
  };

  return ctx;
}
