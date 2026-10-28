/**
 * D4：把契约接到共享包的注入点上（只属于 D4，见 ../api.ts）。
 * 例：`setThemeBackend({ get: () => api.theme.get(), … })`。没有要注入的就保持空函数。
 *
 * D4（kb / mem / sched / local / hub / ext）没有共享包要注入：客户端模块（`../kbClient` 等）直接用
 * `../api`。这里另放它们共用的契约错误小工具。
 */

import type { AppClient } from '@nomi-ai/ai-sdk-client';
import { isContractError } from '@nomi-ai/contract';

export function installKnowledgeBackends(_api: AppClient): void {}

/** 契约调用抛的错误（`ContractError`，按名称与错误码识别）的错误码；不是契约错误时为 undefined */
export function contractErrorCode(err: unknown): string | undefined {
  return isContractError(err) ? err.code : undefined;
}

/** 契约错误换回旧客户端抛的普通 Error（只带 message）：调用方照旧显示 `e.message` */
export function plainError(err: unknown): unknown {
  return contractErrorCode(err) !== undefined ? new Error((err as Error).message) : err;
}
