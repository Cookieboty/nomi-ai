/**
 * 持续任务（契约 `tasks.*`，docs/features/scheduling-calendar.md）的视图侧类型与小工具。
 * 形状与内核 `src/tasks/types.ts` 一致；契约输出是 looseObject，这里按内核类型收窄。
 */
import { getLocale, t } from '@nomi-ai/ui';

import { api, hasTransport } from './api';
import { describeRepeat, type RepeatRule } from './desktopClient';

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

export type ToolClass =
  'read' | 'web' | 'knowledge_write' | 'memory_write' | 'file_write' | 'shell' | 'delegate';

export type Trigger =
  | { kind: 'manual' }
  | { kind: 'schedule'; at: number; repeat?: RepeatRule; catchUpMs?: number }
  | {
      kind: 'event';
      sourceId: string;
      filter: unknown;
      cooldownMs?: number;
      mode: 'observe' | 'act';
    };

export type ExecutorSpec =
  | { kind: 'notify'; text: string }
  | {
      kind: 'nomi';
      model?: string;
      tools: ToolClass[];
      scenario?: string;
      toolset?: string;
      brief?: { doneWhen: string; context?: string; outOfScope?: string };
    }
  | {
      kind: 'cli';
      /** 档位模式（presetId）下由内核按触发时的当前档位解析，cli 可省略 */
      cli?: string;
      source?: 'local' | 'official' | 'thirdParty';
      accountId?: string | null;
      presetId?: string;
      model?: string;
      reasoningEffort?: string;
      cwd: string;
      isolation: 'worktree' | 'shared';
      baseBranch?: string;
      brief?: { doneWhen: string; context?: string; outOfScope?: string };
    };

export interface Wait {
  kind: 'approval' | 'input' | 'grant' | 'taken_over' | 'config';
  requestId?: string;
  detail?: string;
  resumeTo: string;
}

export interface TaskGrant {
  version: number;
  level: 0 | 1 | 2 | 3 | 4;
  paths: string[];
  connections: { connectionId: string; capabilities: string[]; resources: string[] }[];
  clis?: string[];
  /** agent 沙箱里预先允许的类别 */
  sandbox?: string[];
  /** 按风险自动判断（默认开；L3 及以上才生效，显式 false = 每条命令都问我） */
  autoJudge?: boolean;
  grantedAt: number;
  expiresAt?: number;
  revokedAt?: number;
}

export type QueueReason = 'slot' | 'memory' | 'cpu' | 'retry' | 'rate_limit';

export interface TaskQueueInfo {
  reason: QueueReason;
  position: number;
  retryAt?: number;
  activeCount: number;
  maxConcurrent: number;
}

export interface Task {
  id: string;
  title: string;
  goal: string;
  origin: {
    conversationId?: string;
    createdBy: 'user' | 'nomi';
    createdAt: number;
    via?: 'delegate' | 'handoff' | string;
  };
  trigger: Trigger;
  executor: ExecutorSpec;
  grant: TaskGrant;
  budget: {
    maxRetries: number;
  };
  acceptance: 'auto' | 'user';
  priority?: TaskPriority;
  category?: TaskCategory;
  status: TaskStatus;
  enabled: boolean;
  gen: number;
  wait?: Wait;
  pending?: {
    cause: string;
    note?: string;
    notBefore?: number;
  };
  lastAttemptId?: string;
  nextRunAt?: number;
  lastError?: { code: string; message: string };
  endedAt?: number;
  archivedAt?: number;
  archiveReason?: 'user' | 'auto_24h';
  ackedAt?: number;
  lastRunStatus?: 'succeeded' | 'failed' | 'cancelled';
  lastRunAt?: number;
  consecutiveFailures: number;
  updatedAt: number;
}

export const AUTO_ARCHIVE_AFTER_MS = 24 * 3600_000;

export function isRecurringTask(task: Task): boolean {
  return (
    task.trigger.kind === 'event' ||
    (task.trigger.kind === 'schedule' && task.trigger.repeat !== undefined)
  );
}

export function isConversationBacked(task: Task): boolean {
  return task.origin.via === 'delegate' || task.origin.via === 'handoff';
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled' || status === 'expired';
}

export function needsUserAttention(task: Task): boolean {
  if (task.archivedAt != null) return false;
  switch (task.status) {
    case 'waiting_user':
    case 'needs_reconcile':
    case 'awaiting_accept':
      return true;
    case 'failed':
    case 'expired':
      return !isConversationBacked(task) && task.ackedAt == null;
    default:
      return false;
  }
}

export type TaskTrack = 'run' | 'automation';

export function taskTrack(task: Task): TaskTrack {
  return isRecurringTask(task) ? 'automation' : 'run';
}

export function autoArchiveRemainingHours(task: Task, now = Date.now()): number | null {
  if (task.archivedAt != null || isRecurringTask(task) || !isTerminalStatus(task.status)) {
    return null;
  }
  if (
    (task.status === 'failed' || task.status === 'expired') &&
    !isConversationBacked(task) &&
    task.ackedAt == null
  ) {
    return null;
  }
  const ended = task.endedAt ?? task.updatedAt;
  const remainMs = ended + AUTO_ARCHIVE_AFTER_MS - now;
  return remainMs > 0 ? Math.ceil(remainMs / 3600_000) : 0;
}

export function formatQueueReason(info: TaskQueueInfo, now = Date.now()): string {
  switch (info.reason) {
    case 'memory':
      return t('ui.providers-schedule.task-queue-reason-memory');
    case 'cpu':
      return t('ui.providers-schedule.task-queue-reason-cpu');
    case 'rate_limit':
      return t('ui.providers-schedule.task-queue-reason-rate-limit');
    case 'retry': {
      const waitSec = info.retryAt ? Math.max(0, Math.ceil((info.retryAt - now) / 1000)) : 0;
      const countdown = waitSec >= 60 ? `${Math.ceil(waitSec / 60)}m` : `${waitSec}s`;
      return t('ui.providers-schedule.task-queue-reason-retry', countdown);
    }
    case 'slot':
    default:
      return t(
        'ui.providers-schedule.task-queue-reason-slot',
        info.activeCount,
        info.maxConcurrent,
      );
  }
}

export interface Attempt {
  id: string;
  gen: number;
  cause: { kind: string; note?: string };
  status: string;
  startedAt: number;
  endedAt?: number;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number; costKnown: boolean };
  result?: { summary: string; artifacts: { kind: string; ref: string }[] };
  error?: { code: string; message: string };
  /** 执行载体：agent 的后台标签与 worktree */
  carrier?: { tabId?: string; cwd?: string; worktree?: string; sourceCwd?: string };
}

export interface LegacyItem {
  source: 'reminder' | 'schedule';
  id: string;
  title: string;
  enabled: boolean;
  nextRunAt?: number;
  repeat?: RepeatRule;
  lastStatus?: string;
}

export interface JournalEntry {
  t: string;
  at: number;
  event?: string;
  from?: string;
  to?: string;
  msg?: string;
  action?: string;
  attemptId?: string;
  seq?: number;
  summary?: string;
}

/** 某次执行里写了 intent、还没有 done / failed 的对外动作（重启核对卡片上列出来） */
export function pendingExternal(
  journal: readonly JournalEntry[],
  attemptId: string,
): JournalEntry[] {
  const open = new Map<number, JournalEntry>();
  for (const e of journal) {
    if (e.attemptId !== attemptId || e.seq === undefined) continue;
    if (e.t === 'intent') open.set(e.seq, e);
    else if (e.t === 'done' || e.t === 'failed') open.delete(e.seq);
  }
  return [...open.values()];
}

export const INBOX: readonly TaskStatus[] = [
  'waiting_user',
  'needs_reconcile',
  'awaiting_accept',
  'failed',
  'expired',
];

export const tasksAvailable = () => hasTransport();

/** 别处（如会话详情）请求打开任务页并选中某个任务；任务页宿主（useTasksHost）监听 */
export const OPEN_TASK_EVENT = 'nomi:open-task';
export const requestOpenTask = (id: string) =>
  window.dispatchEvent(new CustomEvent<string>(OPEN_TASK_EVENT, { detail: id }));

/** tasks.trace 的一行：工具结果、思考、插话（user）或收尾文字（done） */
export interface TaskTraceLine {
  at?: number;
  tool?: string;
  id?: string;
  input?: string;
  output?: string;
  error?: string;
  startedAt?: number;
  textAt?: number;
  thinking?: string;
  user?: string;
  done?: string;
}

export interface TaskTraceAttempt {
  attemptId: string;
  cause: string;
  note?: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  lines: TaskTraceLine[];
}

export interface TaskLiveView {
  attemptId: string;
  text: string;
  reasoning?: string;
  tools: Array<{ id: string; name: string; input?: string; at: number; textAt: number }>;
}

export interface TaskTraceView {
  attemptId: string | null;
  lines: TaskTraceLine[];
  attempts?: TaskTraceAttempt[];
  live?: TaskLiveView | null;
}

export interface TaskLiveEvent {
  type: 'delta' | 'reasoning' | 'tool' | 'interject' | 'done';
  text?: string;
  id?: string;
  name?: string;
  tool?: string;
  status?: 'start' | 'done' | 'error';
  input?: string;
  output?: string;
  error?: string;
  at?: number;
  startedAt?: number;
  textAt?: number;
}

export interface TaskLivePayload {
  id: string;
  attemptId: string;
  event: TaskLiveEvent;
}

export const tasksApi = {
  list: async () =>
    (await api.tasks.list()) as unknown as {
      tasks: Task[];
      legacy: LegacyItem[];
      queue?: Record<string, TaskQueueInfo>;
    },
  get: async (id: string) =>
    (await api.tasks.get({ id })) as unknown as { task: Task; attempts: Attempt[] } | null,
  journal: async (id: string) => (await api.tasks.journal({ id })) as unknown as JournalEntry[],
  trace: async (id: string) => (await api.tasks.trace({ id })) as TaskTraceView,
  /** 后台任务正在跑时插话（下一步并进上下文）；不在跑 / 这一步不收时 false */
  steer: async (id: string, text: string) => (await api.tasks.steer({ id, text })) === true,
  /** 上一次执行结束后带着这句话再跑一次（结果照常写回来源对话）；updateGoal=true 时同步把新调整并入长期目标 */
  followUp: async (
    id: string,
    text: string,
    images?: Array<{ mime: string; data: string }>,
    updateGoal?: boolean,
  ) =>
    (await api.tasks.followUp({
      id,
      text,
      ...(updateGoal ? { updateGoal: true } : {}),
      ...(images?.length ? { images } : {}),
    })) as {
      ok: boolean;
      reason?: string;
    },
  /** 任务还在排队中时追加本次启动要求 */
  appendQueued: async (id: string, text: string, images?: Array<{ mime: string; data: string }>) =>
    (await api.tasks.appendQueued({
      id,
      text,
      ...(images?.length ? { images } : {}),
    })) as {
      ok: boolean;
      reason?: string;
    },
  /** 更新任务标题 / 目标 / 完成标准 / 验收方式 / 触发器 / 预算 / 重要程度 / 分类 */
  update: (patch: {
    id: string;
    title?: string;
    goal?: string;
    doneWhen?: string;
    acceptance?: 'auto' | 'user';
    trigger?: Trigger;
    budget?: { maxRetries?: number };
    priority?: TaskPriority | null;
    category?: TaskCategory | null;
  }) => api.tasks.update(patch) as unknown as Promise<Task>,
  /** 前台长程任务主动转后台（并可中断当前前台请求） */
  handoffFromChat: (input: {
    reqId?: string;
    conversationId: string;
    projectId?: string;
    title?: string;
    userGoal: string;
    partialContent?: string;
    progressSummary?: string;
    historyContext?: string;
  }) => api.tasks.handoffFromChat(input) as unknown as Promise<Task>,
  /** 正在跑的这次执行的实时事件 */
  onLive: (fn: (payload: TaskLivePayload) => void) =>
    api.on('tasks.live', (p) => fn(p as TaskLivePayload)),
  cancel: (id: string) => api.tasks.cancel({ id }),
  accept: (id: string) => api.tasks.accept({ id }),
  reject: (id: string, feedback: string) => api.tasks.reject({ id, feedback }),
  archive: (id: string) => api.tasks.archive({ id }),
  unarchive: (id: string) => api.tasks.unarchive({ id }),
  ack: (id: string) => api.tasks.ack({ id }),
  archiveAllEnded: () => api.tasks.archiveAllEnded() as unknown as Promise<{ archived: number }>,
  remove: (id: string) => api.tasks.remove({ id }),
  onChange: (fn: () => void) => api.on('tasks.changed', fn),
  /** 看板卡片上的快捷操作（结果随 tasks.changed 刷新） */
  runNow: (id: string) => api.tasks.runNow({ id }),
  pause: (id: string) => api.tasks.pause({ id }),
  resume: (id: string) => api.tasks.resume({ id }),
};

export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';
export type TaskCategory = 'coding' | 'review' | 'research' | 'writing' | 'monitor' | 'chore';
export const PRIORITIES: readonly TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
export const CATEGORIES: readonly TaskCategory[] = [
  'coding',
  'review',
  'research',
  'writing',
  'monitor',
  'chore',
];

export const PRIORITY_LABEL: Record<TaskPriority | 'none', string> = {
  urgent: 'ui.providers-schedule.task-priority-urgent',
  high: 'ui.chat-settings.high',
  medium: 'ui.chat-settings.medium',
  low: 'ui.chat-settings.low',
  none: 'ui.cli-monitor.not-set',
};

export const CATEGORY_LABEL: Record<TaskCategory, string> = {
  coding: 'ui.mascot-theme.interest-coding',
  review: 'ui.providers-schedule.task-category-review',
  research: 'ui.providers-schedule.task-category-research',
  writing: 'ui.mascot-theme.interest-writing',
  monitor: 'ui.providers-schedule.task-category-monitor',
  chore: 'ui.providers-schedule.task-category-chore',
};

/** 类型：没填的按执行者 / 触发器推断（agents → 编程；事件触发 → 盯着某处；其余 → 杂事） */
export function categoryOf(task: Task): TaskCategory {
  if (task.category) return task.category;
  if (task.executor.kind === 'cli') return 'coding';
  if (task.trigger.kind === 'event') return 'monitor';
  return 'chore';
}

/**
 * 进度（看板的列、列表的筛选）：待开始（等触发 / 暂停）→ 进行中（排队、运行）→ 需要你（等批准、补充、验收、核对、失败：
 * 都是等人处理）→ 已结束（完成、取消）
 */
export type TaskStage = 'todo' | 'in_progress' | 'needs_you' | 'done';
export const STAGES: readonly TaskStage[] = ['todo', 'in_progress', 'needs_you', 'done'];
export function stageOf(task: Task): TaskStage {
  if (needsUserAttention(task)) return 'needs_you';
  if (task.status === 'running') return 'in_progress';
  if (task.status === 'idle' || task.status === 'queued') return 'todo';
  return 'done';
}

export const STAGE_LABEL: Record<TaskStage, string> = {
  todo: 'ui.providers-schedule.task-stage-todo',
  in_progress: 'ui.chat-settings.in-progress',
  needs_you: 'ui.providers-schedule.tasks-group-needs-you',
  done: 'ui.mascot-theme.ended',
};

/** 跟界面语言走的完整时间（Go 版 webview 的系统语言可能和界面语言不同） */
export const fmtDateTime = (ms: number) => new Date(ms).toLocaleString(getLocale());

/** 一次执行的状态 → 给人看的说明（不显示内部状态码） */
export const ATTEMPT_STATUS_LABEL: Record<string, string> = {
  running: 'ui.knowledge-local.running',
  waiting_user: 'ui.providers-schedule.task-waiting-approval',
  awaiting_accept: 'ui.providers-schedule.task-awaiting-accept',
  succeeded: 'ui.foundation.done',
  failed: 'ui.foundation.failed',
  cancelled: 'ui.foundation.cancelled',
  interrupted: 'ui.providers-schedule.task-attempt-interrupted',
  taken_over: 'ui.providers-schedule.task-taken-over',
  rejected: 'ui.providers-schedule.task-attempt-rejected',
};
export const attemptStatusLabel = (status: string) =>
  ATTEMPT_STATUS_LABEL[status] ? t(ATTEMPT_STATUS_LABEL[status]!) : status;

/** 列表分组：第一条匹配的胜出，互斥且覆盖全部状态（references） */
export type TaskGroup = 'needs_you' | 'running' | 'waiting_trigger' | 'ended';
export function groupOf(task: Task): TaskGroup {
  if (needsUserAttention(task)) return 'needs_you';
  if (task.status === 'running' || task.status === 'queued') return 'running';
  if (task.status === 'idle') return 'waiting_trigger';
  return 'ended';
}

/** 状态标签：写在等谁、要什么，不写内部状态码 */
export function statusLabel(task: Task): string {
  switch (task.status) {
    case 'waiting_user':
      switch (task.wait?.kind) {
        case 'approval':
          return t('ui.providers-schedule.task-waiting-approval');
        case 'input':
          return t('ui.providers-schedule.task-waiting-input');
        case 'grant':
          return t('ui.providers-schedule.task-waiting-grant');
        case 'taken_over':
          return t('ui.providers-schedule.task-taken-over');
        case 'config':
          return t('ui.providers-schedule.task-waiting-config');
        default:
          return t('ui.providers-schedule.task-waiting-approval');
      }
    case 'needs_reconcile':
      return t('ui.providers-schedule.task-needs-reconcile');
    case 'awaiting_accept':
      return t('ui.providers-schedule.task-awaiting-accept');
    case 'failed':
      return t('ui.foundation.failed');
    case 'expired':
      return t('ui.providers-schedule.task-expired');
    case 'running':
      return t('ui.knowledge-local.running');
    case 'queued':
      return t('ui.mascot-theme.queued');
    case 'idle':
      return task.enabled
        ? t('ui.providers-schedule.task-waiting-trigger')
        : t('ui.providers-schedule.task-paused');
    case 'done':
      return t('ui.foundation.done');
    case 'cancelled':
      return t('ui.foundation.cancelled');
  }
}

export const fmtTime = (ms?: number) =>
  ms
    ? new Date(ms).toLocaleString(getLocale(), {
        month: 'numeric',
        day: 'numeric',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

export function triggerLabel(tr: Trigger): string {
  switch (tr.kind) {
    case 'manual':
      return t('ui.providers-schedule.task-trigger-manual');
    case 'schedule': {
      const at = new Date(tr.at).toLocaleTimeString(getLocale(), {
        hour: '2-digit',
        minute: '2-digit',
      });
      return tr.repeat ? `${describeRepeat(tr.repeat)} ${at}` : fmtTime(tr.at);
    }
    case 'event':
      return t('ui.providers-schedule.task-trigger-event', tr.sourceId);
  }
}

export function executorLabel(ex: ExecutorSpec): string {
  switch (ex.kind) {
    case 'notify':
      return t('ui.providers-schedule.task-executor-notify');
    case 'nomi':
      return t('ui.chat-settings.nomi-section');
    case 'cli':
      return ex.cli ?? ex.presetId ?? '';
  }
}

/** 授权等级的用户可读说明 */
export const LEVEL_LABEL: Record<number, string> = {
  0: 'ui.providers-schedule.task-level-0',
  1: 'ui.providers-schedule.task-level-1',
  2: 'ui.providers-schedule.task-level-2',
  3: 'ui.providers-schedule.task-level-3',
  4: 'ui.providers-schedule.task-level-4',
};

/** 工具类 → 最低授权等级 */
export const TOOL_LEVEL: Record<ToolClass, 1 | 2 | 3> = {
  read: 1,
  web: 1,
  knowledge_write: 2,
  memory_write: 2,
  file_write: 2,
  shell: 3,
  delegate: 1,
};

export const TOOL_LABEL: Record<ToolClass, string> = {
  read: 'ui.providers-schedule.task-tool-read',
  web: 'ui.providers-schedule.task-tool-web',
  knowledge_write: 'ui.providers-schedule.task-tool-knowledge-write',
  memory_write: 'ui.providers-schedule.task-tool-memory-write',
  file_write: 'ui.providers-schedule.task-tool-file-write',
  shell: 'ui.providers-schedule.task-tool-shell',
  delegate: 'ui.slash-commands.hand-off-to-a-coding-assistant',
};
