import type {
  PluginEvent,
  HookContext,
  HookHandler,
  PluginContext,
  ServiceKey,
} from '@nomi-ai/bundle-ig-base';

/**
 * FakePluginContext —— vitest 单测用的最小可注入上下文。
 * - inject/provide：内存 Map，按 ServiceKey.key 定位
 * - on/emit：注册 handler，emit 时同步串行调用
 * - logger：容器数组，便于断言（默认静默）
 * - config：直接返回构造入参
 * - dispose：清理所有 handler，避免测试串扰
 */
export interface FakePluginContext extends PluginContext {
  events: Array<{ evt: PluginEvent; payload: unknown }>;
  logs: Array<{ level: 'info' | 'warn' | 'error' | 'debug'; msg: string; meta?: unknown }>;
  triggerEvent<TPayload>(evt: PluginEvent, payload: TPayload): Promise<void>;
  disposeAll(): void;
}

interface HandlerEntry {
  handler: HookHandler<unknown, unknown>;
}

export function createFakeCtx<TConfig = unknown>(cfg?: TConfig): FakePluginContext {
  const services = new Map<symbol, unknown>();
  const handlers = new Map<PluginEvent, Set<HandlerEntry>>();
  const events: FakePluginContext['events'] = [];
  const logs: FakePluginContext['logs'] = [];

  const ctx: FakePluginContext = {
    events,
    logs,
    logger: {
      info: (msg, meta) => logs.push({ level: 'info', msg, meta }),
      warn: (msg, meta) => logs.push({ level: 'warn', msg, meta }),
      error: (msg, meta) => logs.push({ level: 'error', msg, meta }),
      debug: (msg, meta) => logs.push({ level: 'debug', msg, meta }),
    },
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
      events.push({ evt: event, payload });
    },
    config<T = unknown>(): T {
      return cfg as T;
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
          log: (level, msg, meta) => logs.push({ level, msg, meta }),
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
