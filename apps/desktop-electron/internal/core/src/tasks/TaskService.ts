/**
 * 持续任务服务：组合存储、运行时、执行者与投递，供契约处理函数（`tasks.*`）与 Nomi 工具使用
 * （docs/design/persistent-tasks.md）。
 *
 * - 存储在 `userData/tasks/`；
 * - 执行者按 `executor.kind` 注册（notify 在此；nomi、cli 由各自模块注册进来）；
 * - 投递：只在有结果、需要人、出错时通知；经投递队列（outbox.ts：先存再发、合并、免打扰）。
 *
 * Go 版：apps/desktop-go/internal/core/tasks/service.go。
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { AppEvents } from '../core/appEvents';
import { t } from '../i18n';

import { createNotifyExecutor, type NotifyPort } from './executors/notify';
import {
  legacyItems,
  type LegacyReminder,
  type LegacySchedTask,
  type LegacyTaskItem,
} from './legacy';
import { Outbox } from './outbox';
import {
  TaskRuntime,
  type CreateTaskInput,
  type DeliveryKind,
  type TaskExecutor,
  type UserCommand,
} from './TaskRuntime';
import { TaskStore, type JournalEntry, type TaskRecord } from './TaskStore';
import type { Attempt, Budget, ExecutorSpec, Task, Trigger } from './types';
import { INBOX_STATUSES } from './types';

interface Logger {
  info(m: string, x?: unknown): void;
  warn(m: string, x?: unknown): void;
}

export interface TaskServiceDeps {
  root: string;
  logger: Logger;
  events: AppEvents;
  notify: NotifyPort;
  /** 旧的提醒 / 定时代理任务（只读并入任务页） */
  legacy?: { reminders(): LegacyReminder[]; sched(): LegacySchedTask[] };
  /** 免打扰结束时刻；不在免打扰时 null（DesktopService.notifyPolicy） */
  quietUntil?: () => number | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

/** 通知里的摘要最长多少字 */
const SHORT = 90;
const short = (s: string) => (s.length > SHORT ? `${s.slice(0, SHORT - 2)}…` : s);

export interface CreateFromContract {
  title: string;
  goal: string;
  conversationId?: string;
  trigger: Trigger;
  executor: ExecutorSpec;
  grant: CreateTaskInput['grant'];
  budget?: Partial<Budget>;
  acceptance?: Task['acceptance'];
}

export class TaskService {
  readonly store: TaskStore;
  readonly runtime: TaskRuntime;
  private readonly executors: Partial<Record<ExecutorSpec['kind'], TaskExecutor>>;
  readonly outbox: Outbox;

  constructor(private readonly d: TaskServiceDeps) {
    this.store = new TaskStore(d.root, d.logger);
    this.executors = { notify: createNotifyExecutor(d.notify) };
    const now = d.now ?? Date.now;
    const setTimer =
      d.setTimer ??
      ((fn: () => void, ms: number) => {
        const h = setTimeout(fn, Math.min(ms, 2 ** 31 - 1));
        return () => clearTimeout(h);
      });
    this.outbox = new Outbox({
      file: path.join(d.root, 'outbox.json'),
      now,
      setTimer,
      newId: () => randomUUID(),
      send: (n) =>
        d.notify.notify({ kind: 'reminder', title: n.title, text: n.text, body: n.text }),
      ...(d.quietUntil ? { quietUntil: d.quietUntil } : {}),
      mergedText: (items) => ({
        title: t('electron.common.persistent-tasks'),
        text: t(
          'electron.common.persistent-task-merged',
          new Set(items.map((x) => x.taskId)).size,
          short([...new Set(items.map((x) => x.taskTitle))].join('、')),
        ),
      }),
      delivered: (items) => {
        for (const x of items)
          try {
            this.store.append(x.taskId, { t: 'note', at: now(), msg: `delivered:${x.id}` });
          } catch {
            /* 任务已删 */
          }
      },
      logger: d.logger,
    });
    this.runtime = new TaskRuntime({
      store: this.store,
      executors: this.executors,
      now,
      setTimer,
      newId: (p) => `${p}_${randomUUID().replace(/-/g, '')}`,
      logger: d.logger,
      deliver: (task, what, attempt) => this.deliver(task, what, attempt),
      onChange: (task) => d.events.publish('tasks.changed', { id: task.id }),
      dailyBudgetExceeded: (task, at) =>
        this.spentToday(task.id, at) >= (task.budget.maxCostUsdPerDay ?? Infinity),
    });
  }

  /** 其他模块注册执行者（nomi、cli） */
  registerExecutor(kind: ExecutorSpec['kind'], ex: TaskExecutor): void {
    this.executors[kind] = ex;
  }

  start(): void {
    this.outbox.start();
    this.runtime.start();
  }

  stop(): void {
    this.runtime.stop();
    this.outbox.stop();
  }

  // ---------- 读 ----------

  list(): { tasks: Task[]; legacy: LegacyTaskItem[] } {
    const tasks = this.runtime.list().sort((a, b) => b.updatedAt - a.updatedAt);
    let legacy: LegacyTaskItem[] = [];
    try {
      legacy = this.d.legacy ? legacyItems(this.d.legacy.reminders(), this.d.legacy.sched()) : [];
    } catch (error) {
      this.d.logger.warn('读取旧的提醒 / 定时失败', String(error));
    }
    return { tasks, legacy };
  }

  get(id: string): TaskRecord | null {
    return this.runtime.get(id);
  }

  inbox(): Task[] {
    return this.runtime
      .list()
      .filter((task) => INBOX_STATUSES.includes(task.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  journal(id: string): JournalEntry[] {
    if (!this.runtime.get(id)) return [];
    return this.store.journal(id);
  }

  // ---------- 写 ----------

  create(input: CreateFromContract, createdBy: 'user' | 'nomi' = 'user'): Task {
    const now = (this.d.now ?? Date.now)();
    return this.runtime.create({
      title: input.title,
      goal: input.goal,
      origin: {
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        createdBy,
        createdAt: now,
      },
      trigger: input.trigger,
      executor: input.executor,
      grant: input.grant,
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.acceptance ? { acceptance: input.acceptance } : {}),
    });
  }

  /** 改标题、触发器、预算（不碰授权与状态）；返回更新后的任务 */
  update(
    id: string,
    patch: { title?: string; trigger?: Trigger; budget?: Partial<Budget> },
  ): Task | null {
    return this.runtime.patch(id, patch);
  }

  command(id: string, cmd: UserCommand): { ok: boolean; reason?: string } {
    return this.runtime.command(id, cmd);
  }

  remove(id: string): boolean {
    return this.runtime.remove(id);
  }

  /** 这个任务今天（本机时区）各次执行的已知费用合计；费用未知的不计入（§9：不编造费用） */
  spentToday(id: string, at: number): number {
    const rec = this.runtime.get(id);
    if (!rec) return 0;
    const day = new Date(at);
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    return rec.attempts
      .filter((a) => a.startedAt >= start)
      .reduce((sum, a) => sum + (a.usage.costUsd ?? 0), 0);
  }

  // ---------- 投递 ----------

  private deliver(task: Task, what: DeliveryKind, attempt: Attempt | null): void {
    // notify 执行者的通知本身就是结果
    if (what === 'result' && task.executor.kind === 'notify') return;
    const title = t('electron.common.persistent-tasks');
    let text: string;
    switch (what) {
      case 'result':
        text = t(
          'electron.common.persistent-task-result',
          task.title,
          short(attempt?.result?.summary ?? ''),
        );
        break;
      case 'need_user':
        text = t(
          'electron.common.persistent-task-needs-you',
          task.title,
          short(task.wait?.detail ?? t('electron.common.persistent-task-waiting')),
        );
        break;
      case 'error':
        text = t(
          'electron.common.persistent-task-failed',
          task.title,
          short(task.lastError?.message ?? ''),
        );
        break;
      case 'expired':
        text = t('electron.common.persistent-task-expired', task.title);
        break;
      case 'reconcile':
        text = t('electron.common.persistent-task-reconcile', task.title);
        break;
      case 'auto_paused':
        text = t('electron.common.persistent-task-auto-paused', task.title);
        break;
    }
    // 先进投递队列（先存再发、合并、免打扰），见 outbox.ts
    this.outbox.push({ taskId: task.id, taskTitle: task.title, title, text });
  }
}
