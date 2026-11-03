/**
 * 对外动作的副作用日志（docs/design/persistent-tasks.md §10.2、§10.3）。
 *
 * - 动作执行前先过撤销检查点（任务还在跑、还是这次执行、授权没撤销），再往事件日志写 `intent`
 *   （幂等键 `taskId:attemptId:seq`、内容哈希、给人看的摘要、核对用的目标）；
 * - 成功写 `done`（带外部 id）；确定没生效（参数被拒、4xx）写 `failed`；不确定（超时、断网）什么都不写，
 *   留着 intent，重启后进 `needs_reconcile`；
 * - 重启核对：能自动查的动作（发评论、开 PR 靠正文里的幂等标记）先查，查清了自动续跑；查不了交给用户。
 *
 * Go 版：apps/desktop-go/internal/core/tasks/external.go。
 */
import { createHash } from 'node:crypto';

import type { JournalEntry, TaskRecord, TaskStore } from './TaskStore';
import type { Task } from './types';

export interface ExternalAction {
  /** 能力名：github.comment / github.pr.create / mcp.call */
  action: string;
  /** 给人看（收件箱、核对卡片） */
  summary: string;
  /** 核对用（仓库、编号、分支、MCP 服务器与工具……） */
  target: Record<string, unknown>;
  /** 动作内容（只记哈希） */
  payload: unknown;
}

export interface ExternalJournal {
  /** 先写 intent 再执行 fn；fn 拿到幂等键，能写进外部内容的就写进去（自动核对靠它） */
  run<T>(
    a: ExternalAction,
    fn: (key: string) => Promise<{ value: T; externalId?: string }>,
  ): Promise<T>;
}

/** 请求确定没有生效（参数被拒、4xx）：关掉 intent，重启后不必核对 */
export class ExternalNotAppliedError extends Error {
  readonly notApplied = true;
}

/** 撤销检查点没过：任务已停 / 撤销 / 换了执行 */
export class ExternalCheckpointError extends Error {
  readonly code = 'task_not_running';
}

/** 幂等标记：写进评论 / PR 正文末尾，重启后按它查有没有发出去 */
export const markerOf = (key: string) => `<!-- nomi-task:${key} -->`;

export const contentHash = (a: Pick<ExternalAction, 'action' | 'target' | 'payload'>) =>
  createHash('sha256')
    .update(JSON.stringify([a.action, a.target, a.payload ?? null]))
    .digest('hex')
    .slice(0, 32);

export type OpenIntent = Extract<JournalEntry, { t: 'intent' }>;

/** 某次执行里写了 intent、还没有 done / failed 的对外动作 */
export function openIntents(journal: readonly JournalEntry[], attemptId: string): OpenIntent[] {
  const open = new Map<number, OpenIntent>();
  for (const e of journal) {
    if (e.t === 'intent' && e.attemptId === attemptId) open.set(e.seq, e);
    else if ((e.t === 'done' || e.t === 'failed') && e.attemptId === attemptId) open.delete(e.seq);
  }
  return [...open.values()];
}

/**
 * 当前授权是否还允许这个对外动作：对外动作要 L4；GitHub 写还要这条连接的这项能力覆盖这个仓库。
 * MCP 的逐个工具授权由 PermissionBroker 在调用时按当前授权判（派给 Nomi 的高级权限在运行时补授权）。
 */
export function grantAllows(t: Task, a: ExternalAction): boolean {
  if (t.grant.level < 4) return false;
  if (!a.action.startsWith('github.')) return true;
  const conn = typeof a.target.connectionId === 'string' ? a.target.connectionId : undefined;
  const repo = typeof a.target.repo === 'string' ? a.target.repo.toLowerCase() : '';
  return t.grant.connections.some(
    (g) =>
      (!conn || g.connectionId === conn) &&
      g.capabilities.includes(a.action) &&
      g.resources.some((r) => r.toLowerCase() === repo),
  );
}

export function createExternalJournal(d: {
  store: Pick<TaskStore, 'append' | 'journal'>;
  get(id: string): TaskRecord | null;
  taskId: string;
  attemptId: string;
  now: () => number;
}): ExternalJournal {
  let seq: number | null = null;
  const checkpoint = (a: ExternalAction) => {
    const rec = d.get(d.taskId);
    const t: Task | undefined = rec?.task;
    if (
      !t ||
      t.status !== 'running' ||
      !t.enabled ||
      t.grant.revokedAt !== undefined ||
      rec!.attempts.at(-1)?.id !== d.attemptId
    )
      throw new ExternalCheckpointError('task_not_running');
    // 投递前按任务「当前」授权再核一次：运行中收窄了就不发（#232）
    if (!grantAllows(t, a)) throw new ExternalCheckpointError('not_granted');
  };
  return {
    async run(a, fn) {
      checkpoint(a);
      if (seq === null)
        seq = d.store
          .journal(d.taskId)
          .filter((e) => e.t === 'intent' && e.attemptId === d.attemptId)
          .reduce((m, e) => Math.max(m, (e as OpenIntent).seq), 0);
      const n = ++seq;
      const key = `${d.taskId}:${d.attemptId}:${n}`;
      d.store.append(d.taskId, {
        t: 'intent',
        at: d.now(),
        attemptId: d.attemptId,
        seq: n,
        action: a.action,
        hash: contentHash(a),
        key,
        summary: a.summary.slice(0, 300),
        target: a.target,
      });
      try {
        const r = await fn(key);
        d.store.append(d.taskId, {
          t: 'done',
          at: d.now(),
          attemptId: d.attemptId,
          seq: n,
          ...(r.externalId ? { externalId: r.externalId } : {}),
        });
        return r.value;
      } catch (e) {
        if (e instanceof ExternalNotAppliedError)
          d.store.append(d.taskId, {
            t: 'failed',
            at: d.now(),
            attemptId: d.attemptId,
            seq: n,
            msg: e.message.slice(0, 300),
          });
        throw e;
      }
    },
  };
}

/** 自动核对：查到了 → applied（带外部 id）；确定没有 → not_applied；查不了 → null（交给用户） */
export type Reconciler = (
  intent: OpenIntent,
  task: Task,
) => Promise<{ applied: true; externalId?: string } | { applied: false } | null>;
