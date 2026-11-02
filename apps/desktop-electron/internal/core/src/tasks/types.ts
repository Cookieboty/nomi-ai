/**
 * 持续任务的数据模型（docs/design/persistent-tasks.md §4）。
 *
 * 只放类型与常量，不依赖其他模块；Go 版对应 apps/desktop-go/internal/core/tasks/types.go，JSON 形状一致。
 */
import type { Repeat } from '../schedule/recurrence';

export const TASK_SCHEMA_VERSION = 1;

export type TaskStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'needs_reconcile'
  | 'awaiting_accept'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'expired';

/** 结束态：不再触发、不再接受执行回报 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled', 'expired'];

/** 需要用户处理、出现在收件箱里的状态（§11） */
export const INBOX_STATUSES: readonly TaskStatus[] = [
  'waiting_user',
  'needs_reconcile',
  'awaiting_accept',
  'failed',
  'expired',
];

export type AttemptStatus =
  | 'running'
  | 'waiting_user'
  | 'awaiting_accept'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'taken_over'
  | 'rejected';

export type Trigger =
  | { kind: 'manual' }
  /** 没有 repeat = 一次性定时 */
  | { kind: 'schedule'; at: number; repeat?: Repeat; catchUpMs?: number }
  | {
      kind: 'event';
      sourceId: string;
      filter: unknown;
      cooldownMs?: number;
      /** observe：命中只记录不执行；act：自动执行（§6.3） */
      mode: 'observe' | 'act';
    };

export type ToolClass =
  | 'read'
  | 'web'
  | 'knowledge_write'
  | 'memory_write'
  | 'file_write'
  | 'shell'
  /** 委派授权里 clis 列出的编程助手（§7.3） */
  | 'delegate';

/** 场景：决定编程助手的优先列表（沿用委派的任务类型）；Nomi 自己永远兜底 */
export type TaskScenario = 'coding' | 'prd' | 'review' | 'research';

export type ExecutorSpec =
  | { kind: 'notify'; text: string }
  | { kind: 'nomi'; model?: string; tools: ToolClass[]; scenario?: TaskScenario }
  /** 用户点名的编程助手（钉住）：不可用时问用户，不自己换（§7.3） */
  | {
      kind: 'cli';
      cli: string;
      model?: string;
      reasoningEffort?: string;
      cwd: string;
      isolation: 'worktree' | 'shared';
      /** 对话里委派过来的任务：完成标准、背景、不要碰的范围（提示词用） */
      brief?: { doneWhen: string; context?: string; outOfScope?: string };
      /** 跑命令一律问人（Nomi 处于「逐项确认」时委派出来的任务） */
      askCommands?: boolean;
      /** 对话里派出它的工具调用 id：对话里的子任务卡片据此找到标签（查看、停止、审批） */
      callId?: string;
    };

/** 重要程度（看板按它分组；不影响执行顺序） */
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';
export const TASK_PRIORITIES: readonly TaskPriority[] = ['urgent', 'high', 'medium', 'low'];

/** 任务类型（给人看、看板筛选用；不填按执行者 / 触发器推断，见 taskCategory） */
export type TaskCategory = 'coding' | 'review' | 'research' | 'writing' | 'monitor' | 'chore';
export const TASK_CATEGORIES: readonly TaskCategory[] = [
  'coding',
  'review',
  'research',
  'writing',
  'monitor',
  'chore',
];

/** 能力等级（§8.2）：L0 只通知 … L4 对外副作用 */
export type GrantLevel = 0 | 1 | 2 | 3 | 4;

export interface ConnectionGrant {
  connectionId: string;
  capabilities: string[];
  resources: string[];
}

export interface Grant {
  version: number;
  level: GrantLevel;
  /** 工作区 / 文件夹范围 */
  paths: string[];
  connections: ConnectionGrant[];
  /** 允许调用的编程助手 id（内置或 ACP 外部 CLI）；缺省 = 不调用任何编程助手，只用 Nomi 自己 */
  clis?: string[];
  grantedAt: number;
  expiresAt?: number;
  revokedAt?: number;
}

export interface Budget {
  maxTokensPerAttempt?: number;
  maxDurationMsPerAttempt?: number;
  maxCostUsdPerDay?: number;
  maxRetries: number;
}

/** config：配置变了（点名的编程助手不可用、供应商被删……），用户处理后重跑或放弃（§8.7） */
export type WaitKind = 'approval' | 'input' | 'budget' | 'grant' | 'taken_over' | 'config';

/** 任务停在 waiting_user 的原因 */
export interface Wait {
  kind: WaitKind;
  /** 执行者发起的请求 id（审批 / 补充信息），应答必须对得上 */
  requestId?: string;
  detail?: string;
  /**
   * 处理完回到哪里：执行还活着在等 → running；执行已不在（重启、撤销）→ queued（新开执行续上）；
   * 没有执行 → idle / awaiting_accept
   */
  resumeTo: 'running' | 'queued' | 'idle' | 'awaiting_accept';
}

export type AttemptCause = 'manual' | 'schedule' | 'event' | 'retry' | 'resume' | 'rework';

export interface ExecutionSnapshot {
  grantVersion: number;
  providerId?: string;
  endpoint?: string;
  model?: string;
  cli?: string;
  cwd?: string;
  worktree?: string;
}

export interface TaskError {
  code: string;
  message: string;
}

export interface AttemptResult {
  summary: string;
  artifacts: { kind: string; ref: string }[];
}

export interface Attempt {
  id: string;
  taskId: string;
  gen: number;
  cause: { kind: AttemptCause; eventKey?: string; note?: string; answer?: PendingRun['answer'] };
  snapshot: ExecutionSnapshot;
  status: AttemptStatus;
  startedAt: number;
  endedAt?: number;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number; costKnown: boolean };
  result?: AttemptResult;
  error?: TaskError;
  /** 执行载体：编程助手标签、worktree（续跑、验收回填用；不是任务身份） */
  carrier?: {
    tabId?: string;
    sessionId?: string;
    /** 标签的工作目录（worktree 里对应源目录的位置） */
    cwd?: string;
    worktree?: string;
    sourceCwd?: string;
    gitRoot?: string;
  };
}

/** 下一次执行要带上的说明（重试原因、退回意见、核对结论） */
export interface PendingRun {
  cause: AttemptCause;
  eventKey?: string;
  note?: string;
  /** 重启后才收到的用户回答：交给续跑的执行（§10.3） */
  answer?: { requestId?: string; approve: boolean; input?: string };
  /** 退避：不早于此时刻出队 */
  notBefore?: number;
}

export interface Task {
  id: string;
  title: string;
  goal: string;
  origin: {
    conversationId?: string;
    createdBy: 'user' | 'nomi';
    createdAt: number;
    /** delegate：对话里 delegate_to_cli 后台派出的（完成后结果回到来源对话） */
    via?: 'delegate';
  };
  trigger: Trigger;
  executor: ExecutorSpec;
  grant: Grant;
  budget: Budget;
  acceptance: 'auto' | 'user';
  /** 重要程度；不填 = 未设置 */
  priority?: TaskPriority;
  /** 类型；不填按执行者 / 触发器推断 */
  category?: TaskCategory;
  status: TaskStatus;
  enabled: boolean;
  /** 当前代次；新执行 +1，晚到的回报按代次丢弃（§5.3） */
  gen: number;
  /** 本轮连续重试次数；新触发清零 */
  retryCount: number;
  /** 重复任务连续失败的执行次数；成功一次清零，到 AUTO_PAUSE_AFTER_FAILURES 自动暂停 */
  consecutiveFailures: number;
  wait?: Wait;
  pending?: PendingRun;
  lastAttemptId?: string;
  nextRunAt?: number;
  lastError?: TaskError;
  updatedAt: number;
  schemaVersion: 1;
}
