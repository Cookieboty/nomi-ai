/**
 * TaskRuntime 的确定性测试环境：内存存储、可推进的假时钟、记录调用的假执行者。
 * 单测与 scripts/parity/record-tasks-runtime.mjs 共用；Go 版对应 internal/core/tasks/runtime_harness_test.go。
 */
import {
  TaskRuntime,
  type AttemptReporter,
  type CreateTaskInput,
  type DeliveryKind,
  type TaskExecutor,
  type TaskStoreLike,
  type UserCommand,
} from '../../../src/tasks/TaskRuntime';
import type { JournalEntry, TaskRecord } from '../../../src/tasks/TaskStore';
import type { Task, TaskError } from '../../../src/tasks/types';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class MemStore implements TaskStoreLike {
  recs = new Map<string, TaskRecord>();
  journals = new Map<string, JournalEntry[]>();
  loadAll(): TaskRecord[] {
    return [...this.recs.keys()].sort().map((k) => clone(this.recs.get(k)!));
  }
  save(rec: TaskRecord): TaskRecord {
    const r = clone({ task: rec.task, attempts: rec.attempts.slice(-50) });
    this.recs.set(rec.task.id, r);
    return clone(r);
  }
  append(id: string, e: JournalEntry): void {
    const j = this.journals.get(id) ?? [];
    j.push(clone(e));
    this.journals.set(id, j);
  }
  unconfirmedExternal(id: string, attemptId: string): boolean {
    const open = new Set<number>();
    for (const e of this.journals.get(id) ?? []) {
      if (e.t === 'intent' && e.attemptId === attemptId) open.add(e.seq);
      if (e.t === 'done' && e.attemptId === attemptId) open.delete(e.seq);
    }
    return open.size > 0;
  }
  remove(id: string): void {
    this.recs.delete(id);
    this.journals.delete(id);
  }
}

export class FakeClock {
  t: number;
  private timers: { at: number; fn: () => void; seq: number; live: boolean }[] = [];
  private seq = 0;
  constructor(t0: number) {
    this.t = t0;
  }
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const timer = { at: this.t + ms, fn, seq: this.seq++, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  /** 推进时间，按到期先后执行定时器（执行中新设的定时器若也到期同样执行） */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers = this.timers.filter((x) => x.live);
      const due = this.timers
        .filter((x) => x.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      due.live = false;
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }
}

export type Call = { op: string; taskId: string; gen?: number; [k: string]: unknown };

export class FakeExecutor implements TaskExecutor {
  calls: Call[] = [];
  reporters = new Map<string, AttemptReporter>();
  /** 下次 prepare 返回的错误（按任务 id） */
  prepareError = new Map<string, TaskError>();
  prepare(task: Task) {
    const e = this.prepareError.get(task.id);
    if (e) return { error: e };
    return { grantVersion: task.grant.version, model: 'm' };
  }
  start({ task, attempt, report }: Parameters<TaskExecutor['start']>[0]) {
    this.calls.push({
      op: 'start',
      taskId: task.id,
      gen: attempt.gen,
      attemptId: attempt.id,
      cause: attempt.cause,
    });
    this.reporters.set(task.id, report);
  }
  resume(taskId: string, gen: number, answer: unknown) {
    this.calls.push({ op: 'resume', taskId, gen, answer });
  }
  stop(taskId: string, gen: number, reason: string) {
    this.calls.push({ op: 'stop', taskId, gen, reason });
  }
}

export function makeRuntime(
  t0: number,
  store = new MemStore(),
  opts: { maxConcurrent?: number } = {},
) {
  const clock = new FakeClock(t0);
  const exec = new FakeExecutor();
  const delivered: { taskId: string; what: DeliveryKind; attemptId?: string }[] = [];
  let ids = 0;
  const rt = new TaskRuntime({
    store,
    executors: { nomi: exec, notify: exec, cli: exec },
    now: clock.now,
    setTimer: clock.setTimer,
    newId: (p) => `${p}_${++ids}`,
    logger: { info: () => undefined, warn: () => undefined },
    deliver: (task, what, attempt) =>
      delivered.push({ taskId: task.id, what, ...(attempt ? { attemptId: attempt.id } : {}) }),
    maxConcurrent: opts.maxConcurrent ?? 2,
    heartbeatTimeoutMs: 5 * 60_000,
  });
  return { rt, clock, exec, store, delivered };
}

export const baseInput = (over: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  title: 't',
  goal: 'g',
  origin: { createdBy: 'user', createdAt: 0 },
  trigger: { kind: 'manual' },
  executor: { kind: 'nomi', tools: ['read'] },
  grant: { level: 1, paths: [], connections: [] },
  ...over,
});

export type { UserCommand };
