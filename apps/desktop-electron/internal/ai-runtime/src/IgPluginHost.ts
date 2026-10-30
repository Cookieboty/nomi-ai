/**
 * IgPluginHost —— 在主进程里承载 `@nomi-ai/bundle-ig-*` 插件的最小宿主。
 *
 * 背景：ig bundles 使用 `bundle-ig-base/types/plugin.ts` 定义的轻量插件契约
 * （`definePlugin({ name, apply(ctx, cfg) })` + `ctx.provide/inject/on/emit`）。
 * AiSdkBooter 用本宿主按顺序 apply ig 插件，得到 AIClient 需要的 `PluginContext`
 *（LLM registry / tools / userProfile …）。
 *
 * 语义：
 * - `provide/inject`：按 `ServiceKey.key`（symbol）索引；
 * - `on(evt, fn)`：注册 hook，`fn({ payload, reject, log })`；
 * - `emit(evt, payload)`：异步派发给全部 hook，单个 hook 抛错只记日志；
 * - `config()`：返回当前插件的配置；`logger` 带插件名前缀。
 */

import type {
  PluginEvent,
  HookContext,
  HookHandler,
  PluginContext,
  PluginDefinition,
  ServiceKey,
} from '@nomi-ai/bundle-ig-base';

import type { RuntimeLogger } from './logger';

export interface IgPluginEntry<TConfig = unknown> {
  // 插件配置类型各异，这里以 any 承载异构列表
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugin: PluginDefinition<any>;
  config?: TConfig;
}

export interface IgPluginHost {
  /** 宿主根上下文（交给 AIClient / toSdkContext） */
  readonly ctx: PluginContext;
  /** 已成功 apply 的插件名 */
  readonly applied: readonly string[];
  apply(entries: IgPluginEntry[]): Promise<void>;
  /** 等待 emit 派发完成（测试用） */
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export interface IgPluginHostOptions {
  logger: RuntimeLogger;
  /** 附加到 ctx 上的扩展字段（例如 插件宿主 内核 context），只读暴露 */
  extras?: Record<string, unknown>;
}

class HookRejectedError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HookRejectedError';
  }
}

export function createIgPluginHost(opts: IgPluginHostOptions): IgPluginHost {
  const { logger } = opts;
  const services = new Map<symbol, unknown>();
  const hooks = new Map<PluginEvent, Set<HookHandler<unknown, unknown>>>();
  const applied: { name: string; def: PluginDefinition<unknown>; ctx: PluginContext }[] = [];
  const pending = new Set<Promise<void>>();

  const makeLogger = (prefix: string): PluginContext['logger'] => ({
    info: (msg, meta) => logger.info(`${prefix}${msg}`, ...(meta === undefined ? [] : [meta])),
    warn: (msg, meta) => logger.warn(`${prefix}${msg}`, ...(meta === undefined ? [] : [meta])),
    error: (msg, meta) => logger.error(`${prefix}${msg}`, ...(meta === undefined ? [] : [meta])),
    debug: (msg, meta) => logger.debug?.(`${prefix}${msg}`, ...(meta === undefined ? [] : [meta])),
  });

  const dispatch = async (evt: PluginEvent, payload: unknown, log: PluginContext['logger']) => {
    const set = hooks.get(evt);
    if (!set) return;
    for (const fn of Array.from(set)) {
      const hookCtx: HookContext<unknown> = {
        payload,
        reject: (reason: string, code?: string): never => {
          throw new HookRejectedError(reason, code);
        },
        log: (level, msg, meta) => log[level](msg, meta),
      };
      try {
        await fn(hookCtx);
      } catch (err) {
        if (err instanceof HookRejectedError) {
          log.warn(`hook '${evt}' rejected: ${err.message}`);
          return;
        }
        log.error(`hook '${evt}' threw`, err instanceof Error ? err.message : err);
      }
    }
  };

  const makeCtx = (name: string, config: unknown): PluginContext => {
    const log = makeLogger(name ? `[${name}] ` : '');
    const ctx: PluginContext = {
      on<TPayload = unknown, TResult = void>(
        event: PluginEvent,
        handler: HookHandler<TPayload, TResult>,
      ): () => void {
        let set = hooks.get(event);
        if (!set) hooks.set(event, (set = new Set()));
        const h = handler as unknown as HookHandler<unknown, unknown>;
        set.add(h);
        return () => {
          set!.delete(h);
        };
      },
      emit<TPayload = unknown>(event: PluginEvent, payload: TPayload): void {
        const p = dispatch(event, payload, log).finally(() => pending.delete(p));
        pending.add(p);
      },
      provide<T>(key: ServiceKey<T>, impl: T): void {
        services.set(key.key, impl);
      },
      inject<T>(key: ServiceKey<T>): T | undefined {
        return services.get(key.key) as T | undefined;
      },
      config<T = unknown>(): T {
        return config as T;
      },
      logger: log,
    };
    return Object.assign(ctx, opts.extras ?? {});
  };

  const root = makeCtx('', undefined);

  return {
    ctx: root,
    get applied() {
      return applied.map((a) => a.name);
    },
    async apply(entries) {
      for (const { plugin, config } of entries) {
        const cfg = config ?? {};
        const ctx = makeCtx(plugin.name, cfg);
        await plugin.apply(ctx, cfg);
        applied.push({ name: plugin.name, def: plugin as PluginDefinition<unknown>, ctx });
      }
    },
    async flush() {
      while (pending.size > 0) await Promise.all(Array.from(pending));
    },
    async dispose() {
      for (const a of applied.splice(0).reverse()) {
        try {
          await a.def.dispose?.(a.ctx);
        } catch (err) {
          logger.warn(`plugin ${a.name} dispose threw`, err);
        }
      }
      hooks.clear();
      services.clear();
    },
  };
}
