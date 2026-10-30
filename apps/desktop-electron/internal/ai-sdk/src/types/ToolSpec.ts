/**
 * ToolSpec DTO —— 面向 UI/客户端的工具描述。
 *
 * 与 [`ToolDefinition`](file:///../../bundle-ig-base/src/types/common.ts) 的差异：
 * - 剥离 `execute`（函数）与 `schema`（zod）本身，仅保留可序列化的 JSON Schema，
 *   目的是**通过 IPC 从 runtime 送到 renderer/CLI**，同时保留 dangerous 标志。
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** 从 zod schema 转出的 JSON Schema（IPC-safe） */
  parametersJsonSchema: unknown;
  /** 是否需要 UI 二次确认 */
  dangerous?: boolean;
  /** 该工具是否当前启用 */
  enabled?: boolean;
}

export interface ToolConfirmRequest {
  reqId: string;
  toolName: string;
  /** 待执行的参数（JSON 字符串，IPC-safe） */
  argumentsJson: string;
  reason?: string;
  createdAt: number;
}
