/**
 * 任务投递队列（docs/design/persistent-tasks.md §11；参数依据 persistent-tasks-references.md §2.10）。
 *
 * - 先存再发：条目先写进 `outbox.json`，发出后才移除；重启后补发未发出的（补发不会重新执行任务）；
 * - 合并：距上一次发送不到 MERGE_WINDOW_MS 的条目攒着，窗口结束时合并成一条（第一条立即发，要人处理的事不被拖延）；
 * - 免打扰：期间只攒不发，结束时合并成一条；
 * - 发送失败：2 秒起翻倍、封顶 60 秒重试；连续失败 3 次才记为问题（日志）。
 *
 * Go 版：apps/desktop-go/internal/core/tasks/outbox.go。
 */
import fs from 'node:fs';

import { writePrivateFileAtomic } from '../utils/privateFile';

export const MERGE_WINDOW_MS = 30_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const REPORT_AFTER_FAILURES = 3;

export interface OutboxItem {
  id: string;
  taskId: string;
  /** 任务标题（合并成一条时列出） */
  taskTitle: string;
  title: string;
  text: string;
  at: number;
}

export interface OutboxDeps {
  file: string;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => () => void;
  newId: () => string;
  /** 真正发出去（桌面角色气泡 / 灵动岛 / 系统通知）；抛错 = 发送失败 */
  send: (n: { title: string; text: string }) => void;
  /** 免打扰：返回结束时刻；不在免打扰时返回 null */
  quietUntil?: () => number | null;
  /** 合并后的文案：多条时用 */
  mergedText: (items: OutboxItem[]) => { title: string; text: string };
  /** 发出后：给每个任务记一笔（审计） */
  delivered?: (items: OutboxItem[]) => void;
  logger: { warn(m: string, x?: unknown): void };
}

export class Outbox {
  private items: OutboxItem[] = [];
  private lastSent = Number.NEGATIVE_INFINITY;
  private failures = 0;
  private cancel: (() => void) | null = null;

  constructor(private readonly d: OutboxDeps) {
    this.items = this.load();
  }

  private load(): OutboxItem[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.d.file, 'utf8')) as { items?: unknown };
      return Array.isArray(v.items)
        ? (v.items as OutboxItem[]).filter(
            (x) => x && typeof x.id === 'string' && typeof x.text === 'string',
          )
        : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    try {
      writePrivateFileAtomic(this.d.file, `${JSON.stringify({ items: this.items }, null, 2)}\n`);
    } catch (error) {
      this.d.logger.warn('任务投递队列保存失败', String(error));
    }
  }

  pending(): OutboxItem[] {
    return this.items.map((x) => ({ ...x }));
  }

  /** 启动：补发重启前没发出的 */
  start(): void {
    if (this.items.length) this.schedule(0);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  push(i: Omit<OutboxItem, 'id' | 'at'>): void {
    this.items.push({ ...i, id: this.d.newId(), at: this.d.now() });
    this.persist();
    const now = this.d.now();
    // 免打扰中：等结束；窗口内：等窗口结束；否则立即发
    const quiet = this.d.quietUntil?.() ?? null;
    if (quiet !== null && quiet > now) return this.schedule(quiet - now);
    if (now - this.lastSent < MERGE_WINDOW_MS)
      return this.schedule(this.lastSent + MERGE_WINDOW_MS - now);
    this.flush();
  }

  private schedule(ms: number): void {
    // 已经有更早的定时就不推迟
    if (this.cancel && ms > 0) return;
    this.cancel?.();
    this.cancel = this.d.setTimer(
      () => {
        this.cancel = null;
        this.flush();
      },
      Math.max(0, ms),
    );
  }

  /** 把当前攒着的全部发出去（一条原样，多条合并） */
  flush(): void {
    if (!this.items.length) return;
    const now = this.d.now();
    const quiet = this.d.quietUntil?.() ?? null;
    if (quiet !== null && quiet > now) {
      this.cancel?.();
      this.cancel = null;
      this.schedule(quiet - now);
      return;
    }
    const batch = [...this.items];
    const msg =
      batch.length === 1
        ? { title: batch[0]!.title, text: batch[0]!.text }
        : this.d.mergedText(batch);
    try {
      this.d.send(msg);
    } catch (error) {
      this.failures++;
      if (this.failures >= REPORT_AFTER_FAILURES)
        this.d.logger.warn('任务投递连续失败', { failures: this.failures, error: String(error) });
      const wait = Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
      this.cancel?.();
      this.cancel = null;
      this.schedule(wait);
      return;
    }
    this.failures = 0;
    this.lastSent = now;
    const sent = new Set(batch.map((x) => x.id));
    this.items = this.items.filter((x) => !sent.has(x.id));
    this.persist();
    this.d.delivered?.(batch);
  }
}
