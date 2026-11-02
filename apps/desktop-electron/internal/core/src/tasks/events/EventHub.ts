/**
 * 事件触发（docs/design/persistent-tasks.md §6.3、§6.4）：按任务订阅事件源，去重、排序、批处理，再触发执行。
 *
 * - 每个任务记最近 500 个已处理的 key 与事件源游标（`<root>/<taskId>.json`）；执行失败时释放该批的 key；
 * - observe（默认）：命中只记进任务（最多 100 条），不开执行；用户在详情里「处理这些」或改成 act；
 * - act：第一个事件开窗口，窗口结束（cooldownMs，默认 60 秒）或攒满 20 个就开一次执行，带上整批；
 *   任务还在执行时窗口保持打开，执行结束后再合并开下一次（不打断当前执行）；
 * - 只用出站轮询与本机监视；拉取串行，不低于事件源的最短间隔，遵守对方要求的间隔；失败按 2 倍退避，最多 1 小时。
 *
 * 状态机不知道事件：hub 只经运行时的 fireEvent(taskId, batchKey) 触发，执行者用 batch(taskId, key) 取这一批。
 * Go 版：apps/desktop-go/internal/core/tasks/events/hub.go。
 */
import fs from 'node:fs';
import path from 'node:path';

import { ensurePrivateDir, writePrivateFileAtomic } from '../../utils/privateFile';
import type { Task } from '../types';
import { TERMINAL_STATUSES } from '../types';

import type { EventSource, SourceEvent } from './types';

export const MAX_SEEN = 500;
export const MAX_OBSERVED = 100;
export const MAX_BATCH = 20;
export const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_BATCHES = 20;
const MAX_BACKOFF_MS = 3_600_000;

interface Batch {
  events: SourceEvent[];
  createdAt: number;
}

export interface EventState {
  cursor: string | null;
  /** 已经拉过一次（基线已建立） */
  primed: boolean;
  seen: string[];
  observed: SourceEvent[];
  window: { openedAt: number; events: SourceEvent[] } | null;
  batches: Record<string, Batch>;
  lastPollAt?: number;
  nextPollAt?: number;
  failures: number;
  lastError?: string;
}

const emptyState = (): EventState => ({
  cursor: null,
  primed: false,
  seen: [],
  observed: [],
  window: null,
  batches: {},
  failures: 0,
});

export interface EventHubDeps {
  root: string;
  sources: EventSource[];
  /** 运行时：取任务、事件触发（busy 时返回 ok:false） */
  get(id: string): Task | null;
  fire(id: string, eventKey: string): { ok: boolean; reason?: string };
  /** 观察到的事件变了（tasks.changed） */
  changed(id: string): void;
  /** 最近一次执行的事件批 key（失败时释放用） */
  lastEventKey?(id: string): string | undefined;
  logger: { warn(m: string, x?: unknown): void };
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

interface Sub {
  task: Task;
  source: EventSource;
  dispose: () => void;
  /** 本机监视命中：尽快拉一次 */
  dirty: boolean;
}

const eventTrigger = (t: Task) => (t.trigger.kind === 'event' ? t.trigger : null);

export class EventHub {
  private readonly subs = new Map<string, Sub>();
  private readonly states = new Map<string, EventState>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private cancelTimer: (() => void) | null = null;
  private polling = false;
  private stopped = true;
  private ctrl = new AbortController();
  private seq = 0;

  constructor(private readonly d: EventHubDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer =
      d.setTimer ??
      ((fn, ms) => {
        const h = setTimeout(fn, ms);
        h.unref?.();
        return () => clearTimeout(h);
      });
  }

  sourceIds(): string[] {
    return this.d.sources.map((s) => s.id);
  }

  /** 创建 / 修改事件任务前校验过滤条件 */
  validate(task: Task): string | null {
    const t = eventTrigger(task);
    if (!t) return null;
    const src = this.d.sources.find((s) => s.id === t.sourceId);
    if (!src) return `unknown event source: ${t.sourceId}`;
    return src.validate(t.filter, task);
  }

  start(tasks: Task[]): void {
    this.stopped = false;
    this.ctrl = new AbortController();
    for (const t of tasks) this.sync(t);
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.ctrl.abort();
    this.cancelTimer?.();
    for (const s of this.subs.values()) s.dispose();
    this.subs.clear();
  }

  /** 任务变化时调用：该订阅的订阅、该退订的退订；任务空闲了就把攒着的窗口开出去；执行失败释放 key */
  sync(task: Task): void {
    if (this.stopped) return;
    const t = eventTrigger(task);
    const live =
      !!t &&
      task.enabled &&
      !TERMINAL_STATUSES.includes(task.status) &&
      task.grant.revokedAt === undefined;
    const sub = this.subs.get(task.id);
    if (!live) {
      if (sub) {
        sub.dispose();
        this.subs.delete(task.id);
      }
      if (task.status === 'failed') this.release(task);
      return;
    }
    const source = this.d.sources.find((s) => s.id === t.sourceId);
    if (!source) return;
    if (sub && JSON.stringify(eventTrigger(sub.task)) === JSON.stringify(t)) {
      sub.task = task;
    } else {
      sub?.dispose();
      const next: Sub = { task, source, dispose: () => undefined, dirty: false };
      const disposers: (() => void)[] = [];
      if (source.watch)
        disposers.push(
          source.watch(t.filter, task, () => {
            next.dirty = true;
            this.arm(2_000);
          }),
        );
      if (source.subscribe)
        disposers.push(source.subscribe(t.filter, task, (e) => this.ingest(task.id, [e])));
      next.dispose = () => disposers.forEach((f) => f());
      this.subs.set(task.id, next);
    }
    if (task.status === 'idle') this.maybeFlush(task.id);
    this.arm();
  }

  /** 这一批事件（执行者构造提示词用） */
  batch(taskId: string, key: string): SourceEvent[] {
    return this.state(taskId).batches[key]?.events ?? [];
  }

  observed(taskId: string): SourceEvent[] {
    return [...this.state(taskId).observed];
  }

  status(taskId: string): { lastPollAt?: number; lastError?: string } {
    const s = this.state(taskId);
    return {
      ...(s.lastPollAt ? { lastPollAt: s.lastPollAt } : {}),
      ...(s.lastError ? { lastError: s.lastError } : {}),
    };
  }

  /** 用户在详情里「处理这些」：把观察到的事件开成一次执行（观察模式也可以） */
  processObserved(taskId: string): { ok: boolean; reason?: string } {
    const s = this.state(taskId);
    if (!s.observed.length) return { ok: false, reason: 'empty' };
    const events = s.observed.slice(0, MAX_BATCH);
    const key = this.newBatch(s, events);
    const r = this.d.fire(taskId, key);
    if (!r.ok) {
      delete s.batches[key];
      return r;
    }
    s.observed = s.observed.slice(events.length);
    this.save(taskId);
    this.d.changed(taskId);
    return r;
  }

  /** 忽略观察到的事件 */
  clearObserved(taskId: string): void {
    const s = this.state(taskId);
    s.observed = [];
    this.save(taskId);
    this.d.changed(taskId);
  }

  remove(taskId: string): void {
    this.subs.get(taskId)?.dispose();
    this.subs.delete(taskId);
    this.states.delete(taskId);
    fs.rmSync(this.file(taskId), { force: true });
  }

  // ---------- 内部 ----------

  /** 新事件：去重、排序；observe 记下来，act 进窗口 */
  ingest(taskId: string, events: SourceEvent[]): void {
    const sub = this.subs.get(taskId);
    const t = sub ? eventTrigger(sub.task) : null;
    if (!sub || !t) return;
    const s = this.state(taskId);
    const seen = new Set(s.seen);
    const fresh = events
      .filter((e) => e.key && !seen.has(e.key))
      .sort((a, b) => a.occurredAt - b.occurredAt);
    if (!fresh.length) return;
    for (const e of fresh) seen.add(e.key);
    s.seen = [...s.seen, ...fresh.map((e) => e.key)].slice(-MAX_SEEN);
    if (t.mode === 'observe') {
      s.observed = [...s.observed, ...fresh].slice(-MAX_OBSERVED);
      this.save(taskId);
      this.d.changed(taskId);
      return;
    }
    s.window ??= { openedAt: this.now(), events: [] };
    s.window.events.push(...fresh);
    this.save(taskId);
    this.maybeFlush(taskId);
    this.arm();
  }

  /** 窗口到时间或攒满且任务空闲：开一次执行 */
  private maybeFlush(taskId: string): void {
    const sub = this.subs.get(taskId);
    const t = sub ? eventTrigger(sub.task) : null;
    const s = this.state(taskId);
    if (!sub || !t || !s.window?.events.length) return;
    const cooldown = t.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const due = this.now() >= s.window.openedAt + cooldown || s.window.events.length >= MAX_BATCH;
    if (!due || sub.task.status !== 'idle') return;
    const events = s.window.events.slice(0, MAX_BATCH);
    const key = this.newBatch(s, events);
    const r = this.d.fire(taskId, key);
    if (!r.ok) {
      // 还在忙（或暂停）：窗口留着，空闲后合并开下一次
      delete s.batches[key];
      return;
    }
    const rest = s.window.events.slice(events.length);
    s.window = rest.length ? { openedAt: this.now(), events: rest } : null;
    this.save(taskId);
  }

  private newBatch(s: EventState, events: SourceEvent[]): string {
    const key = `evt:${this.now().toString(36)}:${(++this.seq).toString(36)}`;
    s.batches[key] = { events, createdAt: this.now() };
    const keys = Object.keys(s.batches);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_BATCHES))) delete s.batches[k];
    return key;
  }

  /** 执行失败（不再重试）：失败那次执行的这一批 key 释放掉，下次还能触发 */
  private release(task: Task): void {
    const key = this.d.lastEventKey?.(task.id);
    const s = this.state(task.id);
    const b = key ? s.batches[key] : undefined;
    if (!b) return;
    const drop = new Set(b.events.map((e) => e.key));
    s.seen = s.seen.filter((k) => !drop.has(k));
    delete s.batches[key!];
    this.save(task.id);
  }

  private arm(soonMs?: number): void {
    if (this.stopped) return;
    this.cancelTimer?.();
    const now = this.now();
    let wake = now + 3_600_000;
    for (const [id, sub] of this.subs) {
      const s = this.state(id);
      const t = eventTrigger(sub.task)!;
      if (sub.dirty) wake = Math.min(wake, now + (soonMs ?? 0));
      if (sub.source.poll) wake = Math.min(wake, s.nextPollAt ?? now);
      if (s.window)
        wake = Math.min(wake, s.window.openedAt + (t.cooldownMs ?? DEFAULT_COOLDOWN_MS));
    }
    this.cancelTimer = this.setTimer(() => void this.tick(), Math.max(0, wake - now));
  }

  /** 串行拉取到期的事件源，再看窗口 */
  async tick(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      for (const [id, sub] of [...this.subs]) {
        if (this.stopped) return;
        const s = this.state(id);
        const due = sub.dirty || (s.nextPollAt ?? 0) <= this.now();
        if (sub.source.poll && due) await this.pollOne(id, sub);
        if (this.subs.get(id) === sub) this.maybeFlush(id);
      }
    } finally {
      this.polling = false;
      this.arm();
    }
  }

  private async pollOne(id: string, sub: Sub): Promise<void> {
    const t = eventTrigger(sub.task)!;
    const s = this.state(id);
    sub.dirty = false;
    const started = this.now();
    try {
      const r = await sub.source.poll!(t.filter, s.cursor, {
        task: sub.task,
        signal: this.ctrl.signal,
      });
      if (this.subs.get(id) !== sub) return;
      s.cursor = r.cursor;
      s.lastPollAt = started;
      s.failures = 0;
      delete s.lastError;
      s.nextPollAt = started + Math.max(sub.source.minIntervalMs, r.minNextMs ?? 0);
      if (!s.primed || r.baseline) {
        s.primed = true;
        s.seen = [...s.seen, ...r.events.map((e) => e.key)].slice(-MAX_SEEN);
        this.save(id);
        return;
      }
      this.save(id);
      if (r.events.length) this.ingest(id, r.events);
    } catch (e) {
      if (this.stopped) return;
      s.failures += 1;
      s.lastError = e instanceof Error ? e.message : String(e);
      s.nextPollAt =
        started +
        Math.min(MAX_BACKOFF_MS, sub.source.minIntervalMs * 2 ** Math.min(s.failures, 10));
      this.save(id);
      this.d.logger.warn('event source poll failed', {
        task: id,
        source: sub.source.id,
        error: s.lastError,
      });
    }
  }

  private file(id: string): string {
    return path.join(this.d.root, `${id.replace(/[^\w.-]/g, '_')}.json`);
  }

  private state(id: string): EventState {
    let s = this.states.get(id);
    if (!s) {
      s = this.load(id);
      this.states.set(id, s);
    }
    return s;
  }

  private load(id: string): EventState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as Partial<EventState>;
      return { ...emptyState(), ...raw };
    } catch {
      return emptyState();
    }
  }

  private save(id: string): void {
    try {
      ensurePrivateDir(this.d.root);
      writePrivateFileAtomic(this.file(id), JSON.stringify(this.state(id)));
    } catch (e) {
      this.d.logger.warn('event state save failed', { task: id, error: String(e) });
    }
  }
}
