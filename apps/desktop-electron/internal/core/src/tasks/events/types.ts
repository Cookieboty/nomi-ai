/**
 * 事件源接口（docs/design/persistent-tasks.md §6.1）。Go 版：apps/desktop-go/internal/core/tasks/events/types.go。
 */
import type { Task } from '../types';

export interface SourceEvent {
  /** 去重键：来源内唯一且稳定，如 'github:owner/repo#219:2026-11-02T01:00:00Z' */
  key: string;
  occurredAt: number;
  /** 给用户看（任务详情里的「发现的事」） */
  summary: string;
  /** 给执行者；一律视为外部内容（§8.3） */
  payload: unknown;
}

export interface PollResult {
  events: SourceEvent[];
  cursor: string | null;
  /** 第一次拉：只记下现有的，不当新事件（不然一建任务就把历史全触发一遍） */
  baseline?: boolean;
  /** 对方要求的最短间隔（如 GitHub 的 X-Poll-Interval） */
  minNextMs?: number;
}

export interface SourceContext {
  task: Task;
  signal: AbortSignal;
}

export interface EventSource {
  id: 'app' | 'folder' | 'web' | 'github';
  /** 两次拉取的最短间隔 */
  minIntervalMs: number;
  /** 过滤条件不合法 / 不在授权范围里时返回原因 */
  validate(filter: unknown, task: Task): string | null;
  poll?(filter: unknown, cursor: string | null, ctx: SourceContext): Promise<PollResult>;
  /** 本机推送型：命中时调 changed()，由 hub 立刻安排一次 poll（读取与去重仍走 poll） */
  watch?(filter: unknown, task: Task, changed: () => void): () => void;
  /** 应用内部事件：直接推事件 */
  subscribe?(filter: unknown, task: Task, emit: (e: SourceEvent) => void): () => void;
}
