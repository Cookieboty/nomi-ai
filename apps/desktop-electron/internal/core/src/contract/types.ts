/**
 * 契约处理函数的共用类型与小工具（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 * 内核的域处理函数（`contract/<域>.ts`）与宿主的域处理函数（electron `host/contract/<域>.ts`）共用；
 * 宿主用 `ContractDeps<ContractServices>` 带上自己的服务槽位。
 */

import {
  ContractError,
  type HandlerContext,
  type Handlers,
  type Middleware,
} from '@nomi-ai/contract';
import type { AppContract } from '@nomi-ai/contract/app';
import type { HostPorts } from '@nomi-ai/host-ports';

import type { AppEvents } from '../core/appEvents';

import type { CoreContractServices } from './services';

export type AppHandlers = Handlers<AppContract>;
/** 某个域的处理函数表：`DomainHandlers<ShellProcedureName>` */
export type DomainHandlers<N extends string> = Pick<AppHandlers, N & keyof AppHandlers>;
export type AppHandlerContext = HandlerContext<AppContract>;
export type { AppEventName } from '../core/appEvents';

export interface ContractLoggerLike {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** 每个域的 `create<Domain>Handlers(deps)` 收到的依赖；`S` 是宿主扩展过的服务表 */
export interface ContractDeps<S extends CoreContractServices = CoreContractServices> {
  /** 组合根登记的服务实例；在处理函数**调用时**读取 */
  services: S;
  ports: HostPorts;
  /** 应用事件总线（接在 router 上）：服务直接发布契约事件 `events.publish('<命名空间>.<事件>', payload)` */
  events: AppEvents;
  logger: ContractLoggerLike;
}

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
