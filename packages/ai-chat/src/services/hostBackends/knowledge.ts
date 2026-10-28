/**
 * D4：把契约接到共享包的注入点上（只属于 D4，见 ../api.ts）。
 * 例：`setThemeBackend({ get: () => api.theme.get(), … })`。没有要注入的就保持空函数。
 *
 * D4（kb / mem / sched / local / hub / ext）没有共享包要注入：客户端模块（`../kbClient` 等）直接用
 * `../api`。这里另放它们共用的契约错误小工具。
 */

import type { AppClient } from '@nomi-ai/ai-sdk-client';

export function installKnowledgeBackends(_api: AppClient): void {}

/**
 * 认出契约调用抛的错误（`ContractError`，线上传来的 `{ code, message }`），取出错误码。
 * 按 name 认而不用 instanceof：错误对象由 ai-sdk-client 里的契约运行时创建，与视图 import 的类
 * 不一定是同一个。
 */
export function contractErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error) || err.name !== 'ContractError') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** 契约错误换回旧客户端抛的普通 Error（只带 message）：调用方照旧显示 `e.message` */
export function plainError(err: unknown): unknown {
  return contractErrorCode(err) !== undefined ? new Error((err as Error).message) : err;
}
