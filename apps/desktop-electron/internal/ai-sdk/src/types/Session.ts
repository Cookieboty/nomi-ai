/**
 * 会话 DTO —— 与 插件宿主 session 契约对齐但**只保留 IPC-safe 字段**。
 */

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 可选的会话预设（例如 'companion'），P4/P6 会在装配时使用 */
  agentPreset?: string;
  meta?: Record<string, string | number | boolean>;
}
