// Nomi 插件契约：definePlugin / defineService / PluginContext / 事件名。
// 由 ai-runtime 的 IgPluginHost 承载（见 apps/desktop-electron/internal/ai-runtime/src/IgPluginHost.ts）。

/** 插件事件名 */
export type PluginEvent =
  | 'session/user-message'
  | 'session/assistant-message'
  | 'session/closed'
  | 'agent/pre-request'
  | 'agent/post-final'
  | 'agent/turn-end'
  | 'agent/stopped-by-user'
  | 'agent/regenerate'
  | 'agent/sensory-inject'
  | 'tools/pre-execute'
  | 'tools/post-execute'
  | 'tools/wrap'
  | 'tool/confirm-required'
  | 'tts/chunk'
  | 'tts/end'
  | 'userProfile/changed'
  | 'server:up'
  | 'server:down';

/** Waterfall / hook 上下文（占位；真实由 插件宿主 提供） */
export interface HookContext<TPayload = unknown> {
  payload: TPayload;
  /** 允许中间件返回 reject 以阻断链路 */
  reject: (reason: string, code?: string) => never;
  /** 记录一次 log */
  log: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, meta?: unknown) => void;
}

export type HookHandler<TPayload = unknown, TResult = void> = (
  ctx: HookContext<TPayload>,
) => TResult | Promise<TResult>;

/** 服务/能力键 —— 类似 InjectionKey */
export interface ServiceKey<T> {
  readonly key: symbol;
  readonly typeMarker?: T; // 仅用于类型推断，不会在运行时出现
}

/**
 * 服务键用全局注册的 symbol（`Symbol.for`）：本包同时发 ESM 与 CommonJS，一个进程里可能加载两份（CommonJS 的
 * 内核 + ESM 的无界面宿主 / 测试），各自 `Symbol(name)` 时同名服务键互不相认，provide / inject 对不上。
 * 服务名在全仓库唯一（`ctx.<名字>`）。
 */
export function defineService<T>(name: string): ServiceKey<T> {
  return { key: Symbol.for(`nomi.ig.service:${name}`) } as ServiceKey<T>;
}

/** 插件上下文（占位；子集） */
export interface PluginContext {
  /** 订阅 waterfall / hook */
  on<TPayload = unknown, TResult = void>(
    event: PluginEvent,
    handler: HookHandler<TPayload, TResult>,
  ): () => void;

  /** 触发事件（内部广播） */
  emit<TPayload = unknown>(event: PluginEvent, payload: TPayload): void;

  /** 依赖注入：注册服务 */
  provide<T>(key: ServiceKey<T>, impl: T): void;

  /** 依赖注入：消费服务 */
  inject<T>(key: ServiceKey<T>): T | undefined;

  /** 读取本插件的 patch 配置 */
  config<T = unknown>(): T;

  /** 结构化日志 */
  logger: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
    debug: (msg: string, meta?: unknown) => void;
  };
}

/** 插件定义 */
export interface PluginDefinition<TConfig = unknown> {
  name: string;
  /** 依赖的其他插件 name（可选） */
  requires?: string[];
  apply: (ctx: PluginContext, cfg: TConfig) => void | Promise<void>;
  dispose?: (ctx: PluginContext) => void | Promise<void>;
}

export function definePlugin<TConfig = unknown>(
  def: PluginDefinition<TConfig>,
): PluginDefinition<TConfig> {
  return def;
}
