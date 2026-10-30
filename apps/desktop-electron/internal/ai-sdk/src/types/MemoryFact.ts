/**
 * MemoryFact / SessionSummary DTO —— 记忆层对外投影。
 *
 * 与 [`MemoryFact`](file:///../../bundle-ig-base/src/types/common.ts) 相比:
 * - id、内容以字符串形式暴露；不含数据库内部字段；
 * - `at` 采用 epoch ms 便于 IPC 序列化。
 */

export type MemoryFactKind = 'preference' | 'identity' | 'goal' | 'dislike' | 'habit' | 'note';

export type MemoryFactSource = 'user' | 'inferred' | 'distilled' | 'system';

export interface MemoryFact {
  id: string;
  kind: MemoryFactKind;
  text: string;
  source: MemoryFactSource;
  at: number;
  /** 0~1 蒸馏置信度 */
  confidence?: number;
}

export interface SessionSummary {
  sessionId: string;
  summary: string;
  updatedAt: number;
  stepCount: number;
}
