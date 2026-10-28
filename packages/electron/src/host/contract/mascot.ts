/**
 * D5 的处理函数与事件桥（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 本文件只属于 D5。契约声明在 packages/contract/src/app/mascot.ts；这里：
 * - `createMascotHandlers(deps)`：每个过程一个处理函数，委派给服务的公开方法（服务从
 *   `deps.services` 在调用时读取，缺了用 `need()` 报 UNAVAILABLE）；
 * - `mascotEventBridge`：服务仍在 `events.publish` 的旧通道 → 契约事件。
 */

import type { MascotEventName, MascotProcedureName } from '@nomi-ai/contract/app';

import type { ContractDeps, DomainHandlers, EventBridgeMap } from './types';

export type MascotHandlers = DomainHandlers<MascotProcedureName>;

export function createMascotHandlers(_deps: ContractDeps): MascotHandlers {
  return {};
}

export const mascotEventBridge: EventBridgeMap<MascotEventName> = {};
