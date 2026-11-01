/**
 * 持续任务运行时（docs/design/persistent-tasks.md §5、§9、§10）。
 *
 * 状态机（machine.ts）之外的一切：持有任务、按定时触发、管并发名额、执行 effects、看守执行（心跳 / 时长 / token）。
 * - 事件统一走 dispatch：transition → 存快照 → 记日志 → 执行 effects（「先存再做」）。effects 里回调进来的事件
 *   排队，处理完当前事件再处理，不重入。
 * - 时钟、定时器、id 都注入，单测与 parity 录制完全确定。
 * - 执行者只是接口（notify / nomi / cli），由各自模块实现并注册。
 *
 * Go 版：apps/desktop-go/internal/core/tasks/runtime.go。
 */
import { nextOccurrence } from '../schedule/recurrence';

import { isTerminal, transition, type TaskEffect, type TaskEvent } from './machine';
import type { JournalEntry, TaskRecord } from './TaskStore';
import type {
  Attempt,
  AttemptResult,
  Budget,
  ExecutionSnapshot,
  ExecutorSpec,
  Grant,
  Task,
  TaskError,
  Trigger,
} from './types';
import { TASK_SCHEMA_VERSION } from './types';

/** 补跑窗口默认 12 小时（与原定时任务一致，references §2.2） */
export const DEFAULT_CATCH_UP_MS = 12 * 3600_000;
export const DEFAULT_MAX_CONCURRENT = 3;
/** 执行者这么久没有任何进展回报就判为崩溃（可重试） */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5 * 60_000;
/** 每小时最多新开多少次执行（§8.5 防失控） */
export const DEFAULT_MAX_STARTS_PER_HOUR = 30;
/** 定时器最长睡多久就醒来看一眼 */
const MAX_SLEEP_MS = 60_000;

/** 执行者回报：都带着这次执行的代次，晚到的由状态机丢弃 */
export interface AttemptReporter {
  /** 任何进展（输出、工具调用）都算心跳 */
  heartbeat(): void;
  usage(delta: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    costKnown?: boolean;
  }): void;
  needsUser(wait: { kind: 'approval' | 'input'; requestId?: string; detail?: string }): void;
  completed(result: AttemptResult): void;
  failed(error: TaskError): void;
  takenOver(): void;
  /** 记下执行载体（标签 / worktree），写进这次执行的记录 */
  carrier(c: NonNullable<Attempt['carrier']>): void;
}

export interface AttemptContext {
  task: Task;
  attempt: Attempt;
  /** 上一次执行（续跑 / 退回时复用它的标签与 worktree） */
  previous?: Attempt;
  report: AttemptReporter;
}

export interface TaskExecutor {
  /** 检查这次能不能跑（CLI 是否可用、供应商是否还在），返回执行快照或错误（§8.7） */
  prepare(task: Task): ExecutionSnapshot | { error: TaskError };
  start(ctx: AttemptContext): void;
  resume(
    taskId: string,
    gen: number,
    answer: { requestId?: string; approve: boolean; input?: string },
  ): void;
  /** 协作式停止；pause = 预算用完先停在原地等批准 */
  stop(
    taskId: string,
    gen: number,
    reason: 'cancel' | 'revoked' | 'expired' | 'budget' | 'timeout' | 'pause',
  ): void;
}

export interface TaskStoreLike {
  loadAll(): TaskRecord[];
  save(rec: TaskRecord): TaskRecord;
  append(id: string, entry: JournalEntry): void;
  unconfirmedExternal(id: string, attemptId: string): boolean;
  remove(id: string): void;
}

export type DeliveryKind = Extract<TaskEffect, { kind: 'deliver' }>['what'];

export interface RuntimeDeps {
  store: TaskStoreLike;
  executors: Partial<Record<ExecutorSpec['kind'], TaskExecutor>>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => () => void;
  newId: (prefix: 'task' | 'att') => string;
  logger: { info(m: string, x?: unknown): void; warn(m: string, x?: unknown): void };
  /** 投递（1.10 接 Outbox）；runtime 只说「给谁、什么事」 */
  deliver: (task: Task, what: DeliveryKind, attempt: Attempt | null) => void;
  /** 任务或执行变了（契约事件 tasks.changed） */
  onChange?: (task: Task) => void;
  /** 每日费用预算是否已用完（1.7 接用量） */
  dailyBudgetExceeded?: (task: Task, now: number) => boolean;
  maxConcurrent?: number;
  heartbeatTimeoutMs?: number;
  maxStartsPerHour?: number;
}

export interface CreateTaskInput {
  title: string;
  goal: string;
  origin: Task['origin'];
  trigger: Trigger;
  executor: ExecutorSpec;
  grant: Omit<Grant, 'version' | 'grantedAt'>;
  budget?: Partial<Budget>;
  acceptance?: Task['acceptance'];
}

export type UserCommand =
  | { type: 'runNow' }
  | { type: 'decide'; gen?: number; requestId?: string; approve: boolean; input?: string }
  | { type: 'accept' }
  | { type: 'reject'; feedback: string }
  | { type: 'cancel' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'reconcile'; outcome: 'applied' | 'not_applied' | 'abandon' }
  | { type: 'revoke' }
  | { type: 'grant'; grant: Omit<Grant, 'version' | 'grantedAt'> };

export const DEFAULT_BUDGET: Budget = {
  maxTokensPerAttempt: 200_000,
  maxDurationMsPerAttempt: 30 * 60_000,
  maxCostUsdPerDay: 1,
  maxRetries: 3,
};

/** 授权默认 30 天 */
export const DEFAULT_GRANT_MS = 30 * 86_400_000;

interface Live {
  rec: TaskRecord;
}

export class TaskRuntime {
  private readonly tasks = new Map<string, Live>();
  /** 持有并发名额的任务 */
  private readonly slots = new Set<string>();
  /** 排队等名额的任务（按 notBefore、入队先后） */
  private queue: { id: string; notBefore: number; seq: number }[] = [];
  private seq = 0;
  private readonly beats = new Map<string, number>();
  private starts: number[] = [];
  private inbox: { id: string; ev: TaskEvent }[] = [];
  private dispatching = false;
  private pumping = false;
  /** 准备失败的任务：start_attempt 时不启动执行者，直接记失败 */
  private readonly prepFailed = new Map<string, TaskError>();
  private cancelTimer: (() => void) | null = null;
  private started = false;

  constructor(private readonly d: RuntimeDeps) {}

  private get max() {
    return this.d.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  // ---------- 读 ----------

  list(): Task[] {
    return [...this.tasks.values()].map((l) => l.rec.task);
  }

  get(id: string): TaskRecord | null {
    return this.tasks.get(id)?.rec ?? null;
  }

  private current(id: string): Attempt | null {
    const rec = this.tasks.get(id)?.rec;
    if (!rec?.task.lastAttemptId) return null;
    return rec.attempts.find((a) => a.id === rec.task.lastAttemptId) ?? null;
  }

  // ---------- 生命周期 ----------

  /** 读入全部任务，按 §10.3 核对重启前的执行，补跑错过的定时，开始计时 */
  start(): void {
    if (this.started) return;
    this.started = true;
    const now = this.d.now();
    for (const rec of this.d.store.loadAll()) this.tasks.set(rec.task.id, { rec });
    for (const id of [...this.tasks.keys()]) {
      const attempt = this.current(id);
      const unconfirmed = attempt ? this.d.store.unconfirmedExternal(id, attempt.id) : false;
      this.dispatch(id, { type: 'restarted', at: now, unconfirmedExternal: unconfirmed });
    }
    this.tick();
  }

  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.started = false;
  }

  // ---------- 写 ----------

  create(input: CreateTaskInput): Task {
    const now = this.d.now();
    const task: Task = {
      id: this.d.newId('task'),
      title: input.title,
      goal: input.goal,
      origin: input.origin,
      trigger: input.trigger,
      executor: input.executor,
      grant: {
        expiresAt: now + DEFAULT_GRANT_MS,
        ...input.grant,
        version: 1,
        grantedAt: now,
      },
      budget: { ...DEFAULT_BUDGET, ...input.budget },
      acceptance: input.acceptance ?? (input.executor.kind === 'cli' ? 'user' : 'auto'),
      status: 'idle',
      enabled: true,
      gen: 0,
      retryCount: 0,
      consecutiveFailures: 0,
      updatedAt: now,
      schemaVersion: TASK_SCHEMA_VERSION,
    };
    task.nextRunAt = this.firstRunAt(task, now);
    if (task.nextRunAt === undefined) delete task.nextRunAt;
    const rec = this.d.store.save({ task, attempts: [] });
    this.tasks.set(task.id, { rec });
    this.d.store.append(task.id, {
      t: 'state',
      at: now,
      event: 'create',
      from: 'none',
      to: 'idle',
      gen: 0,
    });
    this.d.onChange?.(task);
    this.arm();
    return task;
  }

  /** 用户操作；返回状态机是否接受 */
  command(id: string, cmd: UserCommand): { ok: boolean; reason?: string } {
    const live = this.tasks.get(id);
    if (!live) return { ok: false, reason: 'not_found' };
    const at = this.d.now();
    const task = live.rec.task;
    switch (cmd.type) {
      case 'runNow':
        return this.trigger(id, 'manual');
      case 'revoke':
        return this.dispatch(id, { type: 'grant_revoked', at });
      case 'grant':
        return this.dispatch(id, {
          type: 'grant_updated',
          at,
          grant: {
            expiresAt: at + DEFAULT_GRANT_MS,
            ...cmd.grant,
            version: task.grant.version + 1,
            grantedAt: at,
          },
        });
      default:
        return this.dispatch(id, { ...cmd, at } as TaskEvent);
    }
  }

  /** 改标题、触发器、预算（不碰授权与状态）；改了定时就重算下一次运行时间 */
  patch(
    id: string,
    p: { title?: string; trigger?: Trigger; budget?: Partial<Budget> },
  ): Task | null {
    const live = this.tasks.get(id);
    if (!live) return null;
    const now = this.d.now();
    const task: Task = { ...live.rec.task, updatedAt: now };
    if (p.title !== undefined) task.title = p.title;
    if (p.budget) task.budget = { ...task.budget, ...p.budget };
    if (p.trigger) {
      task.trigger = p.trigger;
      const next = this.firstRunAt(task, now);
      if (next === undefined) delete task.nextRunAt;
      else task.nextRunAt = next;
    }
    live.rec = this.d.store.save({ task, attempts: live.rec.attempts });
    this.d.store.append(id, {
      t: 'note',
      at: now,
      msg: `patched:${Object.keys(p).sort().join(',')}`,
    });
    this.d.onChange?.(live.rec.task);
    this.arm();
    return live.rec.task;
  }

  /** 只有结束态的任务可以删除 */
  remove(id: string): boolean {
    const live = this.tasks.get(id);
    if (!live || !isTerminal(live.rec.task.status)) return false;
    this.tasks.delete(id);
    this.d.store.remove(id);
    return true;
  }

  // ---------- 触发 ----------

  /** 事件触发（EventHub）：eventKey 是这一批事件的 key；任务在忙 / 暂停时返回 ok:false，由 hub 稍后再开 */
  fireEvent(id: string, eventKey: string): { ok: boolean; reason?: string } {
    if (!this.tasks.has(id)) return { ok: false, reason: 'not_found' };
    return this.trigger(id, 'event', eventKey);
  }

  private trigger(id: string, cause: 'manual' | 'schedule' | 'event', eventKey?: string) {
    const task = this.tasks.get(id)!.rec.task;
    const at = this.d.now();
    const budgetExceeded = this.d.dailyBudgetExceeded?.(task, at) ?? false;
    return this.dispatch(id, {
      type: 'trigger',
      at,
      cause,
      ...(eventKey ? { eventKey } : {}),
      ...(budgetExceeded ? { budgetExceeded } : {}),
    });
  }

  private firstRunAt(task: Task, now: number): number | undefined {
    const t = task.trigger;
    if (t.kind !== 'schedule') return undefined;
    if (!t.repeat) return t.at;
    return t.at > now ? t.at : nextOccurrence(t.repeat, t.at, now);
  }

  /** 下一次定时：一次性的触发过就没有了 */
  private nextRunAfter(task: Task, after: number): number | undefined {
    const t = task.trigger;
    if (t.kind !== 'schedule' || !t.repeat) return undefined;
    return nextOccurrence(t.repeat, t.at, after);
  }

  private setNextRun(id: string, next: number | undefined): void {
    const live = this.tasks.get(id)!;
    const task = { ...live.rec.task };
    if (next === undefined) delete task.nextRunAt;
    else task.nextRunAt = next;
    live.rec = this.d.store.save({ task, attempts: live.rec.attempts });
  }

  /** 到点的定时：补跑窗口内的触发一次；正在跑的跳过（Skip）；暂停的只顺延 */
  private runDueSchedules(now: number): void {
    for (const [id, live] of this.tasks) {
      const task = live.rec.task;
      if (task.trigger.kind !== 'schedule' || task.nextRunAt === undefined || task.nextRunAt > now)
        continue;
      const due = task.nextRunAt;
      const catchUp = task.trigger.catchUpMs ?? DEFAULT_CATCH_UP_MS;
      this.setNextRun(id, this.nextRunAfter(task, now));
      if (!task.enabled || isTerminal(task.status)) continue;
      if (now - due > catchUp) {
        this.note(id, `missed:${due}`);
        continue;
      }
      const r = this.trigger(id, 'schedule');
      if (!r.ok) this.note(id, `skipped:${r.reason ?? ''}`);
    }
  }

  // ---------- 事件 ----------

  private dispatch(id: string, ev: TaskEvent): { ok: boolean; reason?: string } {
    if (this.dispatching) {
      this.inbox.push({ id, ev });
      return { ok: true };
    }
    this.dispatching = true;
    let first: { ok: boolean; reason?: string };
    try {
      first = this.apply(id, ev);
      while (this.inbox.length) {
        const next = this.inbox.shift()!;
        this.apply(next.id, next.ev);
      }
    } finally {
      this.dispatching = false;
    }
    this.pump();
    this.arm();
    return first;
  }

  private apply(id: string, ev: TaskEvent): { ok: boolean; reason?: string } {
    const live = this.tasks.get(id);
    if (!live) return { ok: false, reason: 'not_found' };
    const before = live.rec.task;
    const attempt = this.current(id);
    const r = transition(before, attempt, ev);
    if (!r.ok) {
      for (const e of r.effects) this.run(id, e, r.task, r.attempt);
      return { ok: false, reason: r.reason };
    }
    let attempts = live.rec.attempts;
    if (r.attempt) {
      const i = attempts.findIndex((a) => a.id === r.attempt!.id);
      attempts =
        i >= 0 ? attempts.map((a, k) => (k === i ? r.attempt! : a)) : [...attempts, r.attempt];
    }
    live.rec = this.d.store.save({ task: r.task, attempts });
    if (before.status !== r.task.status || ev.type === 'slot_acquired') {
      this.d.store.append(id, {
        t: 'state',
        at: ev.at,
        event: ev.type,
        from: before.status,
        to: r.task.status,
        gen: r.task.gen,
        ...(r.task.lastAttemptId ? { attemptId: r.task.lastAttemptId } : {}),
      });
    }
    for (const e of r.effects) this.run(id, e, live.rec.task, r.attempt);
    this.d.onChange?.(live.rec.task);
    return { ok: true };
  }

  private note(id: string, msg: string, attemptId?: string): void {
    this.d.store.append(id, {
      t: 'note',
      at: this.d.now(),
      msg,
      ...(attemptId ? { attemptId } : {}),
    });
  }

  private executor(task: Task): TaskExecutor | undefined {
    return this.d.executors[task.executor.kind];
  }

  private run(id: string, e: TaskEffect, task: Task, attempt: Attempt | null): void {
    switch (e.kind) {
      case 'enqueue':
        this.queue = this.queue.filter((q) => q.id !== id);
        this.queue.push({ id, notBefore: e.notBefore ?? 0, seq: this.seq++ });
        return;
      case 'release_slot':
        this.slots.delete(id);
        this.beats.delete(id);
        return;
      case 'acquire_slot':
        // 人工名额：用户回应后恢复，不和新工作抢（references §2.1）
        this.slots.add(id);
        this.beats.set(id, this.d.now());
        return;
      case 'start_attempt': {
        this.slots.add(id);
        this.beats.set(id, this.d.now());
        this.starts.push(this.d.now());
        const ex = this.executor(task);
        const prepError = this.prepFailed.get(id);
        if (prepError) {
          this.prepFailed.delete(id);
          this.inbox.push({
            id,
            ev: { type: 'failed', at: this.d.now(), gen: e.gen, error: prepError },
          });
          return;
        }
        if (!ex || !attempt) {
          this.inbox.push({
            id,
            ev: {
              type: 'failed',
              at: this.d.now(),
              gen: e.gen,
              error: { code: 'executor_failed', message: `no executor: ${task.executor.kind}` },
            },
          });
          return;
        }
        try {
          const all = this.tasks.get(id)?.rec.attempts ?? [];
          const previous = all.filter((a) => a.id !== attempt.id).at(-1);
          ex.start({
            task,
            attempt,
            ...(previous ? { previous } : {}),
            report: this.reporter(id, e.gen),
          });
        } catch (error) {
          this.inbox.push({
            id,
            ev: {
              type: 'failed',
              at: this.d.now(),
              gen: e.gen,
              error: { code: 'executor_crashed', message: String(error) },
            },
          });
        }
        return;
      }
      case 'resume_attempt':
        this.executor(task)?.resume(id, e.gen, {
          ...(e.requestId !== undefined ? { requestId: e.requestId } : {}),
          approve: e.approve,
          ...(e.input !== undefined ? { input: e.input } : {}),
        });
        return;
      case 'stop_attempt':
        this.executor(task)?.stop(id, e.gen, e.reason);
        return;
      case 'deliver':
        this.d.deliver(task, e.what, attempt);
        return;
      case 'schedule_next': {
        if (task.trigger.kind === 'schedule') {
          const next = this.nextRunAfter(task, this.d.now());
          if (next !== task.nextRunAt) this.setNextRun(id, next);
        }
        return;
      }
      case 'drop_stale':
        this.note(id, `stale:${e.event}`, attempt?.id);
        return;
    }
  }

  private reporter(id: string, gen: number): AttemptReporter {
    const now = () => this.d.now();
    const live = () => {
      const t = this.tasks.get(id)?.rec.task;
      return t && t.gen === gen ? t : null;
    };
    return {
      heartbeat: () => {
        if (live()) this.beats.set(id, now());
      },
      usage: (delta) => this.addUsage(id, gen, delta),
      needsUser: (wait) => this.dispatch(id, { type: 'needs_user', at: now(), gen, wait }),
      completed: (result) => this.dispatch(id, { type: 'completed', at: now(), gen, result }),
      failed: (error) => this.dispatch(id, { type: 'failed', at: now(), gen, error }),
      takenOver: () => this.dispatch(id, { type: 'taken_over', at: now(), gen }),
      carrier: (c) => {
        const live = this.tasks.get(id);
        const attempt = this.current(id);
        if (!live || !attempt || attempt.gen !== gen) return;
        const next = { ...attempt, carrier: { ...attempt.carrier, ...c } };
        live.rec = this.d.store.save({
          task: live.rec.task,
          attempts: live.rec.attempts.map((a) => (a.id === attempt.id ? next : a)),
        });
      },
    };
  }

  /** 累计这次执行的用量；超过每次执行的 token 上限就先停在原地，等用户批准（§9） */
  private addUsage(
    id: string,
    gen: number,
    delta: { inputTokens?: number; outputTokens?: number; costUsd?: number; costKnown?: boolean },
  ): void {
    const live = this.tasks.get(id);
    const attempt = this.current(id);
    if (!live || !attempt || attempt.gen !== gen || live.rec.task.gen !== gen) return;
    this.beats.set(id, this.d.now());
    const u = attempt.usage;
    const cost = delta.costUsd !== undefined ? (u.costUsd ?? 0) + delta.costUsd : u.costUsd;
    const usage = {
      inputTokens: u.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: u.outputTokens + (delta.outputTokens ?? 0),
      ...(cost !== undefined ? { costUsd: cost } : {}),
      costKnown: u.costKnown && delta.costKnown !== false,
    };
    const next = { ...attempt, usage };
    live.rec = this.d.store.save({
      task: live.rec.task,
      attempts: live.rec.attempts.map((a) => (a.id === attempt.id ? next : a)),
    });
    const limit = live.rec.task.budget.maxTokensPerAttempt;
    if (
      limit !== undefined &&
      live.rec.task.status === 'running' &&
      usage.inputTokens + usage.outputTokens > limit
    ) {
      this.executor(live.rec.task)?.stop(id, gen, 'pause');
      this.dispatch(id, {
        type: 'needs_user',
        at: this.d.now(),
        gen,
        wait: { kind: 'budget', detail: `tokens>${limit}` },
      });
    }
  }

  // ---------- 名额与计时 ----------

  /** 有空名额就让排在最前、已到时间的任务开跑 */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      this.pumpOnce();
    } finally {
      this.pumping = false;
    }
  }

  private pumpOnce(): void {
    const now = this.d.now();
    this.starts = this.starts.filter((t) => now - t < 3600_000);
    const maxStarts = this.d.maxStartsPerHour ?? DEFAULT_MAX_STARTS_PER_HOUR;
    this.queue.sort((a, b) => a.notBefore - b.notBefore || a.seq - b.seq);
    while (this.slots.size < this.max && this.starts.length < maxStarts) {
      const i = this.queue.findIndex((q) => q.notBefore <= now);
      if (i < 0) return;
      const [q] = this.queue.splice(i, 1);
      const live = this.tasks.get(q.id);
      if (!live || live.rec.task.status !== 'queued') continue;
      const ex = this.executor(live.rec.task);
      const prepared = ex?.prepare(live.rec.task) ?? {
        error: { code: 'executor_failed', message: `no executor: ${live.rec.task.executor.kind}` },
      };
      const attemptId = this.d.newId('att');
      if ('error' in prepared) this.prepFailed.set(q.id, prepared.error);
      const snapshot =
        'error' in prepared ? { grantVersion: live.rec.task.grant.version } : prepared;
      // 准备失败（配置变了等）：照常开一次执行再立即记失败，错误码决定是否重试
      this.dispatch(q.id, { type: 'slot_acquired', at: now, attemptId, snapshot });
      this.prepFailed.delete(q.id);
    }
  }

  /** 看守：心跳超时判崩溃；超过每次执行的时长上限判超时 */
  private watch(now: number): void {
    const timeout = this.d.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    for (const id of [...this.slots]) {
      const live = this.tasks.get(id);
      const attempt = this.current(id);
      if (!live || !attempt || live.rec.task.status !== 'running') continue;
      const task = live.rec.task;
      const max = task.budget.maxDurationMsPerAttempt;
      if (max !== undefined && now - attempt.startedAt > max) {
        this.executor(task)?.stop(id, task.gen, 'timeout');
        this.dispatch(id, {
          type: 'failed',
          at: now,
          gen: task.gen,
          error: { code: 'timed_out', message: `>${max}ms` },
        });
        continue;
      }
      const beat = this.beats.get(id) ?? attempt.startedAt;
      if (now - beat > timeout) {
        this.executor(task)?.stop(id, task.gen, 'cancel');
        this.dispatch(id, {
          type: 'failed',
          at: now,
          gen: task.gen,
          error: { code: 'executor_crashed', message: 'heartbeat_timeout' },
        });
      }
    }
  }

  /** 定时器醒来：看守、到点的定时、出队 */
  tick(): void {
    const now = this.d.now();
    this.watch(now);
    this.runDueSchedules(now);
    this.pump();
    this.arm();
  }

  /** 把定时器设到最近要发生的事（下一次定时、退避结束），最多睡 MAX_SLEEP_MS */
  private arm(): void {
    if (!this.started) return;
    this.cancelTimer?.();
    const now = this.d.now();
    let wake = now + MAX_SLEEP_MS;
    for (const { rec } of this.tasks.values())
      if (rec.task.enabled && rec.task.nextRunAt !== undefined)
        wake = Math.min(wake, rec.task.nextRunAt);
    for (const q of this.queue) if (q.notBefore > now) wake = Math.min(wake, q.notBefore);
    this.cancelTimer = this.d.setTimer(() => this.tick(), Math.max(0, wake - now));
  }

  /** 单测：当前占名额的任务 */
  slotHolders(): string[] {
    return [...this.slots].sort();
  }
}
