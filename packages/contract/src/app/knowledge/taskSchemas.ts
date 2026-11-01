/**
 * 持续任务（`tasks.*`）的契约 schema（docs/design/persistent-tasks.md §4、§14）。
 * 形状与内核的 `src/tasks/types.ts` 一致；读出的对象用 looseObject（内核可以多带字段），写入的输入严格校验。
 */
import { z } from 'zod';

import { RepeatRule } from './schemas';

export const TaskStatus = z.enum([
  'idle',
  'queued',
  'running',
  'waiting_user',
  'needs_reconcile',
  'awaiting_accept',
  'done',
  'failed',
  'cancelled',
  'expired',
]);

export const TaskTrigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({
    kind: z.literal('schedule'),
    at: z.number(),
    repeat: RepeatRule.optional(),
    catchUpMs: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal('event'),
    sourceId: z.string(),
    filter: z.unknown(),
    cooldownMs: z.number().int().min(0).optional(),
    mode: z.enum(['observe', 'act']),
  }),
]);

export const TaskToolClass = z.enum([
  'read',
  'web',
  'knowledge_write',
  'memory_write',
  'file_write',
  'shell',
  'delegate',
]);

export const TaskExecutorSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('notify'), text: z.string().min(1).max(2000) }),
  z.object({
    kind: z.literal('nomi'),
    model: z.string().optional(),
    tools: z.array(TaskToolClass),
    scenario: z.enum(['coding', 'prd', 'review', 'research']).optional(),
  }),
  z.object({
    kind: z.literal('cli'),
    cli: z.string().min(1),
    model: z.string().optional(),
    cwd: z.string().min(1),
    isolation: z.enum(['worktree', 'shared']),
  }),
]);

export const TaskConnectionGrant = z.object({
  connectionId: z.string(),
  capabilities: z.array(z.string()),
  resources: z.array(z.string()),
});

/** 用户在授权卡片上给出的授权（版本与时间由内核填） */
export const TaskGrantInput = z.object({
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  paths: z.array(z.string()),
  connections: z.array(TaskConnectionGrant),
  clis: z.array(z.string()).optional(),
  expiresAt: z.number().optional(),
});

export const TaskBudgetInput = z.object({
  maxTokensPerAttempt: z.number().int().positive().optional(),
  maxDurationMsPerAttempt: z.number().int().positive().optional(),
  maxCostUsdPerDay: z.number().nonnegative().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
});

export const TaskCreateInput = z.object({
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(8000),
  conversationId: z.string().optional(),
  trigger: TaskTrigger,
  executor: TaskExecutorSpec,
  grant: TaskGrantInput,
  budget: TaskBudgetInput.optional(),
  acceptance: z.enum(['auto', 'user']).optional(),
});

/** 读出的任务（内核的 Task；looseObject：新字段不需要改契约） */
export const TaskView = z.looseObject({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  status: TaskStatus,
  enabled: z.boolean(),
  gen: z.number(),
  trigger: z.looseObject({ kind: z.string() }),
  executor: z.looseObject({ kind: z.string() }),
  grant: z.looseObject({ version: z.number(), level: z.number() }),
  updatedAt: z.number(),
});

export const TaskAttemptView = z.looseObject({
  id: z.string(),
  gen: z.number(),
  status: z.string(),
  startedAt: z.number(),
});

export const TaskRecordView = z.looseObject({
  task: TaskView,
  attempts: z.array(TaskAttemptView),
});

/** 旧的提醒 / 定时代理任务（只读并入任务页，设计稿 §13 的 2.1.0 调整） */
export const LegacyTaskItem = z.object({
  source: z.enum(['reminder', 'schedule']),
  id: z.string(),
  title: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.number().optional(),
  repeat: RepeatRule.optional(),
  lastStatus: z.string().optional(),
});

export const TaskListResult = z.object({
  tasks: z.array(TaskView),
  legacy: z.array(LegacyTaskItem),
});

export const TaskJournalEntry = z.looseObject({ t: z.string(), at: z.number() });

export const TaskCmdResult = z.object({ ok: z.boolean(), reason: z.string().optional() });
