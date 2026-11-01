/**
 * 持续任务状态机（docs/design/persistent-tasks.md §5；取舍依据 persistent-tasks-references.md）。
 *
 * 纯函数：`transition(task, attempt, event) → { ok, task, attempt, effects }`。
 * - 不读时钟、不生成 id：时刻在 `event.at`，新执行的 id 由 `slot_acquired` 带进来；
 * - 不做副作用：启动 / 停止执行、通知、并发名额都以 `effects` 返回，由 TaskRuntime 执行；
 * - 输入不被修改，返回新对象；不合法的事件返回 `ok: false` 和原对象。
 *
 * 并发名额：只有 `running` 占名额。停下来等人（waiting_user）立即释放；用户回应后用预留的「人工名额」恢复
 * （`acquire_slot { reserved: true }`），新工作挡不住人推进已有工作（references §2.1）。
 *
 * Go 版：apps/desktop-go/internal/core/tasks/machine.go，由 scripts/parity/record-tasks-machine.mjs 的 golden 守住一致。
 */
import { AUTO_PAUSE_AFTER_FAILURES, isRetryable, retryBackoffMs } from './errors';
import type {
  Attempt,
  AttemptResult,
  ExecutionSnapshot,
  Grant,
  PendingRun,
  Task,
  TaskError,
  TaskStatus,
  Wait,
} from './types';
import { TERMINAL_STATUSES } from './types';

export type TaskEvent =
  /** 触发一次执行（runNow / 定时到点 / 事件命中）；budgetExceeded 由运行时按每日预算算好 */
  | {
      type: 'trigger';
      at: number;
      cause: 'manual' | 'schedule' | 'event';
      eventKey?: string;
      budgetExceeded?: boolean;
    }
  /** 运行时拿到并发名额，新建一次执行 */
  | { type: 'slot_acquired'; at: number; attemptId: string; snapshot: ExecutionSnapshot }
  /** 执行者停下来等用户：要确认的动作、要补充的信息、本次预算用完 */
  | {
      type: 'needs_user';
      at: number;
      gen: number;
      wait: { kind: 'approval' | 'input' | 'budget'; requestId?: string; detail?: string };
    }
  | { type: 'completed'; at: number; gen: number; result: AttemptResult }
  /** 是否重试由错误码决定（errors.ts），退避由重试次数算出 */
  | { type: 'failed'; at: number; gen: number; error: TaskError }
  /** 用户在编程助手标签里接管 */
  | { type: 'taken_over'; at: number; gen: number }
  /** 用户回应 waiting_user */
  | {
      type: 'decide';
      at: number;
      gen?: number;
      requestId?: string;
      approve: boolean;
      input?: string;
    }
  | { type: 'accept'; at: number }
  | { type: 'reject'; at: number; feedback: string }
  | { type: 'cancel'; at: number }
  | { type: 'pause'; at: number }
  | { type: 'resume'; at: number }
  | { type: 'reconcile'; at: number; outcome: 'applied' | 'not_applied' | 'abandon' }
  /** 应用重启后对每个任务跑一次；unconfirmedExternal = 事件日志里有 intent 没 done（§10.3） */
  | { type: 'restarted'; at: number; unconfirmedExternal: boolean }
  | { type: 'grant_revoked'; at: number }
  | { type: 'grant_expired'; at: number }
  | { type: 'grant_updated'; at: number; grant: Grant };

export type TaskEffect =
  | { kind: 'start_attempt'; attemptId: string; gen: number }
  /** 协作式停止：执行者在下一个检查点停下，已完成的副作用不回滚（references §2.8） */
  | { kind: 'stop_attempt'; gen: number; reason: 'cancel' | 'revoked' | 'expired' | 'budget' }
  /** 恢复一个停下来等人的执行前先拿名额；reserved = 用预留的人工名额 */
  | { kind: 'acquire_slot'; gen: number; reserved: true }
  | {
      kind: 'resume_attempt';
      gen: number;
      requestId?: string;
      approve: boolean;
      input?: string;
    }
  /** 任务进了 queued：运行时去拿并发名额（不早于 notBefore） */
  | { kind: 'enqueue'; notBefore?: number }
  | { kind: 'release_slot'; gen: number }
  | {
      kind: 'deliver';
      what: 'result' | 'need_user' | 'error' | 'expired' | 'reconcile' | 'auto_paused';
      attemptId?: string;
    }
  /** 重复任务回到 idle：运行时算下一次触发时间 */
  | { kind: 'schedule_next' }
  /** 晚到的回报（代次已前进），只记日志 */
  | { kind: 'drop_stale'; gen: number; event: TaskEvent['type'] };

export type TransitionReason =
  'illegal' | 'stale' | 'terminal' | 'paused' | 'busy' | 'not_ready' | 'grant';

export interface TransitionResult {
  ok: boolean;
  reason?: TransitionReason;
  task: Task;
  attempt: Attempt | null;
  effects: TaskEffect[];
}

export const isTerminal = (s: TaskStatus): boolean => TERMINAL_STATUSES.includes(s);

/** 重复任务：事件触发，或带 repeat 的定时。一次执行结束回到 idle */
export function isRecurring(task: Task): boolean {
  const t = task.trigger;
  return t.kind === 'event' || (t.kind === 'schedule' && t.repeat !== undefined);
}

const isActive = (a: Attempt | null): a is Attempt =>
  a !== null && (a.status === 'running' || a.status === 'waiting_user');

const grantExpired = (task: Task, at: number) =>
  task.grant.expiresAt !== undefined && task.grant.expiresAt <= at;

function reject(
  task: Task,
  attempt: Attempt | null,
  reason: TransitionReason,
  effects: TaskEffect[] = [],
): TransitionResult {
  return { ok: false, reason, task, attempt, effects };
}

function accept(task: Task, attempt: Attempt | null, effects: TaskEffect[]): TransitionResult {
  return { ok: true, task, attempt, effects };
}

/** 去掉值为 undefined 的键：保持与 Go 版 omitempty 的 JSON 形状一致 */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

function withTask(task: Task, at: number, patch: Partial<Task>): Task {
  return clean({ ...task, ...patch, updatedAt: at });
}

function withAttempt(a: Attempt, patch: Partial<Attempt>): Attempt {
  return clean({ ...a, ...patch });
}

/** 只有 running 占名额 */
function releaseIfHeld(task: Task, gen: number, fx: TaskEffect[]): void {
  if (task.status === 'running') fx.push({ kind: 'release_slot', gen });
}

/** 执行成功结束（或用户验收 / 自己做完）时任务的去向 */
function settle(task: Task, at: number, fx: TaskEffect[]): Task {
  const base = { wait: undefined, pending: undefined, consecutiveFailures: 0, retryCount: 0 };
  if (isRecurring(task)) {
    if (task.enabled) fx.push({ kind: 'schedule_next' });
    return withTask(task, at, { ...base, status: 'idle' });
  }
  return withTask(task, at, { ...base, status: 'done' });
}

/**
 * 不再重试时任务的去向。countFailure：执行者失败才计入连续失败（用户拒绝预算、放弃核对不算）；
 * 重复任务连续失败到上限自动暂停（references §2.4）。
 */
function giveUp(
  task: Task,
  at: number,
  error: TaskError,
  fx: TaskEffect[],
  countFailure: boolean,
): Task {
  fx.push({ kind: 'deliver', what: 'error', attemptId: task.lastAttemptId });
  const base = { lastError: error, wait: undefined, pending: undefined, retryCount: 0 };
  if (!isRecurring(task)) return withTask(task, at, { ...base, status: 'failed' });
  const failures = countFailure ? task.consecutiveFailures + 1 : task.consecutiveFailures;
  if (failures >= AUTO_PAUSE_AFTER_FAILURES) {
    fx.push({ kind: 'deliver', what: 'auto_paused' });
    return withTask(task, at, {
      ...base,
      status: 'idle',
      enabled: false,
      consecutiveFailures: failures,
    });
  }
  if (task.enabled) fx.push({ kind: 'schedule_next' });
  return withTask(task, at, { ...base, status: 'idle', consecutiveFailures: failures });
}

function enqueue(
  task: Task,
  at: number,
  pending: PendingRun,
  fx: TaskEffect[],
  patch: Partial<Task> = {},
): Task {
  fx.push(clean({ kind: 'enqueue' as const, notBefore: pending.notBefore }));
  return withTask(task, at, {
    ...patch,
    status: 'queued',
    wait: undefined,
    pending: clean({ ...pending }),
  });
}

/** 执行者回报的公共检查：代次对得上、执行还在 */
function checkGen(task: Task, attempt: Attempt | null, ev: TaskEvent & { gen: number }) {
  if (isTerminal(task.status) || ev.gen !== task.gen || !attempt || attempt.gen !== ev.gen) {
    return reject(task, attempt, 'stale', [{ kind: 'drop_stale', gen: ev.gen, event: ev.type }]);
  }
  return null;
}

/** 停掉一个还活着的执行（取消 / 撤销 / 到期 / 拒绝预算） */
function stopActive(
  task: Task,
  attempt: Attempt,
  at: number,
  reason: 'cancel' | 'revoked' | 'expired' | 'budget',
  fx: TaskEffect[],
  error?: TaskError,
): Attempt {
  fx.push({ kind: 'stop_attempt', gen: attempt.gen, reason });
  releaseIfHeld(task, attempt.gen, fx);
  return withAttempt(attempt, { status: 'cancelled', endedAt: at, error });
}

export function transition(task: Task, attempt: Attempt | null, ev: TaskEvent): TransitionResult {
  const at = ev.at;
  const fx: TaskEffect[] = [];

  switch (ev.type) {
    case 'trigger': {
      const fromOk =
        task.status === 'idle' ||
        (ev.cause === 'manual' && (task.status === 'failed' || task.status === 'done'));
      // busy：运行时按触发器决定跳过（定时）还是合并进下一次（事件），references §2.2
      if (!fromOk) return reject(task, attempt, isTerminal(task.status) ? 'terminal' : 'busy');
      if (!task.enabled) return reject(task, attempt, 'paused');
      if (task.grant.revokedAt !== undefined) return reject(task, attempt, 'grant');
      if (grantExpired(task, at)) {
        fx.push({ kind: 'deliver', what: 'expired' });
        return accept(withTask(task, at, { status: 'expired' }), attempt, fx);
      }
      const pending: PendingRun = clean({ cause: ev.cause, eventKey: ev.eventKey });
      if (ev.budgetExceeded) {
        fx.push({ kind: 'deliver', what: 'need_user' });
        return accept(
          withTask(task, at, {
            status: 'waiting_user',
            retryCount: 0,
            wait: { kind: 'budget', resumeTo: 'queued' },
            pending,
          }),
          attempt,
          fx,
        );
      }
      return accept(enqueue(task, at, pending, fx, { retryCount: 0 }), attempt, fx);
    }

    case 'slot_acquired': {
      if (task.status !== 'queued') return reject(task, attempt, 'illegal');
      if (!task.enabled) return reject(task, attempt, 'paused');
      if (task.pending?.notBefore !== undefined && task.pending.notBefore > at)
        return reject(task, attempt, 'not_ready');
      if (grantExpired(task, at)) {
        fx.push({ kind: 'deliver', what: 'expired' });
        return accept(withTask(task, at, { status: 'expired', pending: undefined }), attempt, fx);
      }
      const gen = task.gen + 1;
      const p: PendingRun = task.pending ?? { cause: 'manual' };
      const next: Attempt = clean({
        id: ev.attemptId,
        taskId: task.id,
        gen,
        cause: clean({ kind: p.cause, eventKey: p.eventKey, note: p.note, answer: p.answer }),
        snapshot: ev.snapshot,
        status: 'running' as const,
        startedAt: at,
        usage: { inputTokens: 0, outputTokens: 0, costKnown: true },
      });
      fx.push({ kind: 'start_attempt', attemptId: ev.attemptId, gen });
      return accept(
        withTask(task, at, {
          status: 'running',
          gen,
          lastAttemptId: ev.attemptId,
          pending: undefined,
        }),
        next,
        fx,
      );
    }

    case 'needs_user': {
      const bad = checkGen(task, attempt, ev);
      if (bad) return bad;
      if (task.status !== 'running') return reject(task, attempt, 'illegal');
      const wait: Wait = clean({ ...ev.wait, resumeTo: 'running' as const });
      fx.push({ kind: 'release_slot', gen: ev.gen });
      fx.push({ kind: 'deliver', what: 'need_user', attemptId: attempt!.id });
      return accept(
        withTask(task, at, { status: 'waiting_user', wait }),
        withAttempt(attempt!, { status: 'waiting_user' }),
        fx,
      );
    }

    case 'completed': {
      const bad = checkGen(task, attempt, ev);
      if (bad) return bad;
      if (task.status !== 'running') return reject(task, attempt, 'illegal');
      const a = attempt!;
      fx.push({ kind: 'release_slot', gen: ev.gen });
      fx.push({ kind: 'deliver', what: 'result', attemptId: a.id });
      if (task.acceptance === 'user') {
        return accept(
          withTask(task, at, {
            status: 'awaiting_accept',
            retryCount: 0,
            consecutiveFailures: 0,
            lastError: undefined,
          }),
          withAttempt(a, { status: 'awaiting_accept', endedAt: at, result: ev.result }),
          fx,
        );
      }
      return accept(
        withTask(settle(task, at, fx), at, { lastError: undefined }),
        withAttempt(a, { status: 'succeeded', endedAt: at, result: ev.result }),
        fx,
      );
    }

    case 'failed': {
      const bad = checkGen(task, attempt, ev);
      if (bad) return bad;
      if (task.status !== 'running' && task.status !== 'waiting_user')
        return reject(task, attempt, 'illegal');
      const a = withAttempt(attempt!, { status: 'failed', endedAt: at, error: ev.error });
      releaseIfHeld(task, ev.gen, fx);
      if (isRetryable(ev.error.code) && task.retryCount < task.budget.maxRetries) {
        const retryCount = task.retryCount + 1;
        const notBefore = at + retryBackoffMs(retryCount);
        return accept(
          enqueue(task, at, { cause: 'retry', note: ev.error.code, notBefore }, fx, {
            retryCount,
            lastError: ev.error,
          }),
          a,
          fx,
        );
      }
      return accept(giveUp(task, at, ev.error, fx, true), a, fx);
    }

    case 'taken_over': {
      const bad = checkGen(task, attempt, ev);
      if (bad) return bad;
      if (task.status !== 'running' && task.status !== 'waiting_user')
        return reject(task, attempt, 'illegal');
      releaseIfHeld(task, ev.gen, fx);
      fx.push({ kind: 'deliver', what: 'need_user', attemptId: attempt!.id });
      return accept(
        withTask(task, at, {
          status: 'waiting_user',
          gen: task.gen + 1,
          wait: { kind: 'taken_over', resumeTo: 'idle' },
        }),
        withAttempt(attempt!, { status: 'taken_over', endedAt: at }),
        fx,
      );
    }

    case 'decide': {
      if (task.status !== 'waiting_user' || !task.wait) return reject(task, attempt, 'illegal');
      const w = task.wait;
      if (ev.gen !== undefined && ev.gen !== task.gen)
        return reject(task, attempt, 'stale', [
          { kind: 'drop_stale', gen: ev.gen, event: ev.type },
        ]);
      if (w.requestId !== undefined && ev.requestId !== w.requestId)
        return reject(task, attempt, 'stale', [
          { kind: 'drop_stale', gen: ev.gen ?? task.gen, event: ev.type },
        ]);

      if (w.kind === 'grant') return reject(task, attempt, 'illegal');

      if (w.kind === 'taken_over') {
        // 批准 = 用户做完了，算完成；否则交回给执行者继续
        if (ev.approve) return accept(settle(task, at, fx), attempt, fx);
        return accept(
          enqueue(task, at, clean({ cause: 'resume' as const, note: ev.input }), fx),
          attempt,
          fx,
        );
      }

      const budgetDenied = w.kind === 'budget' && !ev.approve;
      const denyError = { code: 'budget_denied', message: 'budget_denied' };

      // 执行还活着、停在这里等：拿人工名额后原地继续
      if (w.resumeTo === 'running') {
        if (!isActive(attempt)) return reject(task, attempt, 'illegal');
        if (budgetDenied) {
          const a = stopActive(task, attempt, at, 'budget', fx, denyError);
          return accept(giveUp(task, at, denyError, fx, false), a, fx);
        }
        fx.push({ kind: 'acquire_slot', gen: task.gen, reserved: true });
        fx.push(
          clean({
            kind: 'resume_attempt' as const,
            gen: task.gen,
            requestId: w.requestId,
            approve: ev.approve,
            input: ev.input,
          }),
        );
        return accept(
          withTask(task, at, { status: 'running', wait: undefined }),
          withAttempt(attempt, { status: 'running' }),
          fx,
        );
      }

      // 执行已不在（触发时预算已用完，或重启时停在等人）：新开执行，把回答带过去
      if (budgetDenied) return accept(giveUp(task, at, denyError, fx, false), attempt, fx);
      const prev: PendingRun = task.pending ?? { cause: 'resume' };
      const pending: PendingRun =
        w.kind === 'budget'
          ? prev
          : clean({
              ...prev,
              answer: clean({ requestId: w.requestId, approve: ev.approve, input: ev.input }),
            });
      return accept(enqueue(task, at, pending, fx), attempt, fx);
    }

    case 'accept': {
      if (task.status !== 'awaiting_accept' || !attempt) return reject(task, attempt, 'illegal');
      return accept(settle(task, at, fx), withAttempt(attempt, { status: 'succeeded' }), fx);
    }

    case 'reject': {
      if (task.status !== 'awaiting_accept' || !attempt) return reject(task, attempt, 'illegal');
      return accept(
        enqueue(task, at, { cause: 'rework', note: ev.feedback }, fx),
        withAttempt(attempt, { status: 'rejected' }),
        fx,
      );
    }

    case 'cancel': {
      if (isTerminal(task.status)) return reject(task, attempt, 'terminal');
      let a = attempt;
      const awaiting = attempt?.status === 'awaiting_accept';
      if (isActive(attempt)) a = stopActive(task, attempt, at, 'cancel', fx);
      // 取消保留成果：结果与 worktree 留着，只是不再等验收
      else if (attempt && awaiting) a = withAttempt(attempt, { status: 'cancelled' });
      return accept(
        withTask(task, at, {
          status: 'cancelled',
          gen: task.gen + 1,
          wait: undefined,
          pending: undefined,
        }),
        a,
        fx,
      );
    }

    case 'pause': {
      if (!task.enabled || isTerminal(task.status)) return reject(task, attempt, 'illegal');
      // 暂停不影响已在跑的执行；还没开始的排队取消
      const patch: Partial<Task> = { enabled: false };
      if (task.status === 'queued') Object.assign(patch, { status: 'idle', pending: undefined });
      return accept(withTask(task, at, patch), attempt, fx);
    }

    case 'resume': {
      if (task.enabled || isTerminal(task.status)) return reject(task, attempt, 'illegal');
      if (task.status === 'idle' && isRecurring(task)) fx.push({ kind: 'schedule_next' });
      return accept(withTask(task, at, { enabled: true, consecutiveFailures: 0 }), attempt, fx);
    }

    case 'reconcile': {
      if (task.status !== 'needs_reconcile') return reject(task, attempt, 'illegal');
      if (ev.outcome === 'abandon')
        return accept(
          giveUp(
            task,
            at,
            { code: 'reconcile_abandoned', message: 'reconcile_abandoned' },
            fx,
            false,
          ),
          attempt,
          fx,
        );
      return accept(
        enqueue(task, at, { cause: 'resume', note: `reconciled:${ev.outcome}` }, fx),
        attempt,
        fx,
      );
    }

    case 'restarted': {
      // 进程都没了：活着的执行一律中断，代次前进，晚到的回报作废
      const running = task.status === 'running' && isActive(attempt);
      const waiting =
        task.status === 'waiting_user' && task.wait?.resumeTo === 'running' && isActive(attempt);
      if (running || waiting) {
        const a = withAttempt(attempt!, { status: 'interrupted', endedAt: at });
        const gen = task.gen + 1;
        if (ev.unconfirmedExternal) {
          fx.push({ kind: 'deliver', what: 'reconcile', attemptId: attempt!.id });
          return accept(
            withTask(task, at, { gen, status: 'needs_reconcile', wait: undefined }),
            a,
            fx,
          );
        }
        if (waiting) {
          // 等人的保持原样：问题不丢、不重问；回答后新开执行续上（references §2.5）
          return accept(
            withTask(task, at, {
              gen,
              wait: { ...task.wait!, resumeTo: 'queued' },
              pending: { cause: 'resume' },
            }),
            a,
            fx,
          );
        }
        return accept(enqueue(task, at, { cause: 'resume' }, fx, { gen }), a, fx);
      }
      if (task.status === 'queued')
        fx.push(clean({ kind: 'enqueue' as const, notBefore: task.pending?.notBefore }));
      return accept(task, attempt, fx);
    }

    case 'grant_revoked': {
      if (isTerminal(task.status)) return reject(task, attempt, 'terminal');
      const grant = { ...task.grant, revokedAt: at };
      if (task.status === 'waiting_user' && task.wait?.kind === 'grant')
        return accept(withTask(task, at, { grant }), attempt, fx);
      let a = attempt;
      let gen = task.gen;
      let resumeTo: Wait['resumeTo'] = 'idle';
      if (isActive(attempt)) {
        a = stopActive(task, attempt, at, 'revoked', fx);
        resumeTo = 'queued';
        gen += 1;
      } else if (task.status === 'queued' || task.wait?.resumeTo === 'queued') {
        resumeTo = 'queued';
      } else if (task.status === 'awaiting_accept') {
        resumeTo = 'awaiting_accept';
      }
      fx.push({ kind: 'deliver', what: 'need_user' });
      return accept(
        withTask(task, at, {
          grant,
          gen,
          status: 'waiting_user',
          wait: { kind: 'grant', resumeTo },
          // 被撤销打断的执行，重新授权后从头再来
          pending: resumeTo === 'queued' ? (task.pending ?? { cause: 'resume' }) : undefined,
        }),
        a,
        fx,
      );
    }

    case 'grant_expired': {
      if (isTerminal(task.status)) return reject(task, attempt, 'terminal');
      let a = attempt;
      let gen = task.gen;
      if (isActive(attempt)) {
        a = stopActive(task, attempt, at, 'expired', fx);
        gen += 1;
      }
      fx.push({ kind: 'deliver', what: 'expired' });
      return accept(
        withTask(task, at, { status: 'expired', gen, wait: undefined, pending: undefined }),
        a,
        fx,
      );
    }

    case 'grant_updated': {
      if (ev.grant.version <= task.grant.version) return reject(task, attempt, 'illegal');
      if (task.status === 'expired') {
        if (isRecurring(task) && task.enabled) fx.push({ kind: 'schedule_next' });
        return accept(withTask(task, at, { grant: ev.grant, status: 'idle' }), attempt, fx);
      }
      if (isTerminal(task.status)) return reject(task, attempt, 'terminal');
      if (task.status === 'waiting_user' && task.wait?.kind === 'grant') {
        const to = task.wait.resumeTo;
        if (to === 'queued' || to === 'running') {
          const p: PendingRun = task.pending ?? { cause: 'resume' };
          return accept(enqueue(task, at, p, fx, { grant: ev.grant }), attempt, fx);
        }
        if (to === 'idle' && isRecurring(task) && task.enabled) fx.push({ kind: 'schedule_next' });
        const status: TaskStatus = to === 'awaiting_accept' ? 'awaiting_accept' : 'idle';
        return accept(
          withTask(task, at, { grant: ev.grant, status, wait: undefined }),
          attempt,
          fx,
        );
      }
      // 收窄授权：直接生效，状态不变
      return accept(withTask(task, at, { grant: ev.grant }), attempt, fx);
    }
  }
}
