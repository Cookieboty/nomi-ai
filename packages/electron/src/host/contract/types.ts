/**
 * 宿主侧契约组装的共用类型与小工具（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 * 本文件属于 P1b 基础，域代理只引用、不改。
 */

import {
  ContractError,
  type HandlerContext,
  type Handlers,
  type Middleware,
} from '@nomi-ai/contract';
import type { AppContract } from '@nomi-ai/contract/app';
import type { HostPorts } from '@nomi-ai/host-ports';

import type { AppEvents } from '../../core/appEvents';

import type { ContractServices } from './services';

export type AppHandlers = Handlers<AppContract>;
/** 某个域的处理函数表：`DomainHandlers<ShellProcedureName>` */
export type DomainHandlers<N extends string> = Pick<AppHandlers, N & keyof AppHandlers>;
export type AppHandlerContext = HandlerContext<AppContract>;
export type AppEventName = keyof AppContract['events'] & string;

export interface ContractLoggerLike {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** 每个域的 `create<Domain>Handlers(deps)` 收到的依赖 */
export interface ContractDeps {
  /** 组合根登记的服务实例；在处理函数**调用时**读取 */
  services: ContractServices;
  ports: HostPorts;
  /** 应用事件总线（已接上契约事件桥）：服务照旧 `events.publish(<旧通道>, payload)` */
  events: AppEvents;
  logger: ContractLoggerLike;
}

/**
 * 旧通道 → 契约事件。服务继续 `events.publish('ai:theme:changed', state)`，桥把它同时发成契约事件
 * `theme.changed`（只推给订阅了的窗口）。payload 与契约 schema 不一致时用 `map` 转换。
 */
export type EventBridgeEntry<E extends string = AppEventName> =
  E | { event: E; map: (payload: unknown) => unknown };
export type EventBridgeMap<E extends string = AppEventName> = Readonly<
  Record<string, EventBridgeEntry<E>>
>;

/** 服务没有创建（启动失败 / 平台不支持）：以 UNAVAILABLE 失败，视图按「功能不可用」处理 */
export function need<T>(service: T | null | undefined, name: string): T {
  if (service === undefined || service === null) {
    throw new ContractError('UNAVAILABLE', `Service '${name}' is not available`);
  }
  return service;
}

/** 调用方窗口的 webContents id（Electron IPC 传输填写 `caller.id = String(senderId)`） */
export function callerWebContentsId(ctx: Pick<AppHandlerContext, 'caller'>): number | undefined {
  const n = Number(ctx.caller.id);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export type { Middleware };
