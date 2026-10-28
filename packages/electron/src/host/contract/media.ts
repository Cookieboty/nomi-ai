/**
 * D1 的处理函数与事件桥（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 本文件只属于 D1。契约声明在 packages/contract/src/app/media.ts；这里：
 * - `createMediaHandlers(deps)`：每个过程一个处理函数，委派给服务的公开方法（服务从
 *   `deps.services` 在调用时读取，缺了用 `need()` 报 UNAVAILABLE）；
 * - `mediaEventBridge`：服务仍在 `events.publish` 的旧通道 → 契约事件。
 */

import type { MediaEventName, MediaProcedureName } from '@nomi-ai/contract/app';

import type { ContractDeps, DomainHandlers, EventBridgeMap } from './types';

export type MediaHandlers = DomainHandlers<MediaProcedureName>;

export function createMediaHandlers(_deps: ContractDeps): MediaHandlers {
  return {};
}

export const mediaEventBridge: EventBridgeMap<MediaEventName> = {};
