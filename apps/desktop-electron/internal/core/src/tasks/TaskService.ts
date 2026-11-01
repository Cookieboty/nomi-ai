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

import { applyWorktreeToMain } from '../cli/delegate/worktree';
import type { AppEvents } from '../core/appEvents';
import { t } from '../i18n';

import { EventHub } from './events/EventHub';
import type { EventSource, SourceEvent } from './events/types';
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

/** 事件触发器不合法（契约里映射成 TASKS_BAD_TRIGGER） */
export class TaskTriggerError extends Error {
  readonly code = 'bad_trigger';
}

export class TaskService {
  readonly store: TaskStore;
  readonly runtime: TaskRuntime;
  private readonly executors: Partial<Record<ExecutorSpec['kind'], TaskExecutor>>;
  readonly outbox: Outbox;
  /** 事件触发（§6）：事件源由各模块注册（registerSource） */
  readonly events: EventHub;
  private readonly sources: EventSource[] = [];

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
      onChange: (task) => {
        d.events.publish('tasks.changed', { id: task.id });
        this.events?.sync(task);
      },
      dailyBudgetExceeded: (task, at) =>
        this.spentToday(task.id, at) >= (task.budget.maxCostUsdPerDay ?? Infinity),
    });
    this.events = new EventHub({
      root: path.join(d.root, 'events'),
      sources: this.sources,
      get: (id) => this.runtime.get(id)?.task ?? null,
      fire: (id, key) => this.runtime.fireEvent(id, key),
      changed: (id) => d.events.publish('tasks.changed', { id }),
      lastEventKey: (id) => this.runtime.get(id)?.attempts.at(-1)?.cause.eventKey,
      logger: d.logger,
      now,
      setTimer,
    });
  }

  /** 事件源（app / folder / web / github），须在 start 之前 */
  registerSource(src: EventSource): void {
    this.sources.push(src);
  }

  /** 执行者取这次执行要处理的事件 */
  eventBatch(taskId: string, eventKey: string | undefined): SourceEvent[] {
    return eventKey ? this.events.batch(taskId, eventKey) : [];
  }

  /** 其他模块注册执行者（nomi、cli） */
  registerExecutor(kind: ExecutorSpec['kind'], ex: TaskExecutor): void {
    this.executors[kind] = ex;
  }

  start(): void {
    this.outbox.start();
    this.runtime.start();
    this.events.start(this.runtime.list());
  }

  stop(): void {
    this.events.stop();
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
    this.checkTrigger(input.trigger, input.grant.connections ?? [], input.grant.paths ?? []);
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
    const cur = this.runtime.get(id)?.task;
    if (!cur) return null;
    if (patch.trigger) {
      // 改成自动执行是放宽授权：只能经 setMode（dangerous，界面里先确认），这里保留原来的模式
      if (patch.trigger.kind === 'event')
        patch = {
          ...patch,
          trigger: {
            ...patch.trigger,
            mode: cur.trigger.kind === 'event' ? cur.trigger.mode : 'observe',
          },
        };
      this.checkTrigger(patch.trigger!, cur.grant.connections, cur.grant.paths);
    }
    return this.runtime.patch(id, patch);
  }

  /** 事件任务：只记录 ↔ 自动执行（改成自动执行是放宽授权，契约里是 dangerous） */
  setMode(id: string, mode: 'observe' | 'act'): Task | null {
    const cur = this.runtime.get(id)?.task;
    if (!cur || cur.trigger.kind !== 'event') return null;
    return this.runtime.patch(id, { trigger: { ...cur.trigger, mode } });
  }

  /** 事件触发器：事件源存在、过滤条件合法且在授权范围里；不合法时返回原因 */
  validateTrigger(
    trigger: Trigger,
    connections: Task['grant']['connections'],
    paths: string[],
  ): string | null {
    if (trigger.kind !== 'event') return null;
    return this.events.validate({ trigger, grant: { connections, paths } } as unknown as Task);
  }

  private checkTrigger(
    trigger: Trigger,
    connections: Task['grant']['connections'],
    paths: string[],
  ): void {
    const err = this.validateTrigger(trigger, connections, paths);
    if (err) throw new TaskTriggerError(err);
  }

  command(id: string, cmd: UserCommand): { ok: boolean; reason?: string } {
    return this.runtime.command(id, cmd);
  }

  remove(id: string): boolean {
    const ok = this.runtime.remove(id);
    if (ok) this.events.remove(id);
    return ok;
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

  /**
   * 验收卡片上的「回填」（§5.4、§7.2）：把最近一次执行在 worktree 里的改动拷回主工作区。
   * 每个目标按用户当前授权检查（mayWrite）；主工作区里已有改动的文件不覆盖（冲突）。
   */
  async applyWorktree(
    id: string,
    mayWrite: (dest: string) => boolean | Promise<boolean>,
  ): Promise<{
    applied: string[];
    skipped: string[];
    conflicted: string[];
    denied: string[];
  } | null> {
    const rec = this.runtime.get(id);
    const a = rec?.attempts
      .slice()
      .reverse()
      .find((x) => x.carrier?.worktree && x.result);
    if (!rec || !a?.carrier?.worktree || !a.carrier.gitRoot) return null;
    const files = (a.result?.artifacts ?? []).filter((x) => x.kind === 'file').map((x) => x.ref);
    const r = await applyWorktreeToMain(
      {
        kind: 'worktree',
        cwd: a.carrier.cwd ?? a.carrier.worktree,
        sourceCwd: a.carrier.sourceCwd ?? a.carrier.worktree,
        gitRoot: a.carrier.gitRoot,
        worktreePath: a.carrier.worktree,
        note: '',
      },
      files,
      mayWrite,
    );
    this.store.append(id, {
      t: 'note',
      at: (this.d.now ?? Date.now)(),
      msg: `applied:${r.applied.length} conflicted:${r.conflicted.length} denied:${r.denied.length}`,
      attemptId: a.id,
    });
    return r;
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
