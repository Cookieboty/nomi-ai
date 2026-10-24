/**
 * 模型质量记录的存储（docs/design/model-quality.md §4.2）：
 * - 每天一个文件 userData/usage/quality/YYYY-MM-DD.jsonl（本地日期，0600），只追加；
 * - 写盘攒批、异步（默认 500 ms 一次），退出时同步写完；
 * - 最近 7 天按需读进内存并增量更新，更早的按查询范围临时读取；
 * - 超过保留天数的文件按天删除；clear() 删除全部。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { QualityRecord } from '@nomi-ai/types';

import { sanitizeRecord } from './fromGateway';

type Logger = { warn(m: string, d?: unknown): void };

export const QUALITY_RETENTION_CHOICES = [7, 30, 90] as const;
export const DEFAULT_RETENTION_DAYS = 30;
/** 常驻内存的最近天数 */
const CACHE_DAYS = 7;
const DAY_MS = 86_400_000;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface QualityLedgerDeps {
  /** userData/usage/quality */
  dir: string;
  logger?: Logger;
  now?: () => number;
  /** 写盘攒批间隔（ms），默认 500；0 = 每条立即同步写（测试） */
  flushMs?: number;
}

/** 本地日期键 YYYY-MM-DD */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 日期键 → 当天本地零点 */
function dayStart(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

export class QualityLedger {
  private readonly days = new Map<string, QualityRecord[]>();
  private readonly pending = new Map<string, string[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly d: QualityLedgerDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private file(key: string): string {
    return path.join(this.d.dir, `${key}.jsonl`);
  }

  append(rec: QualityRecord): void {
    const key = dayKey(rec.ts);
    const cached = this.days.get(key);
    if (cached) cached.push(rec);
    else if (this.isRecent(key)) this.days.set(key, [...this.readDay(key), rec]);
    const lines = this.pending.get(key) ?? [];
    lines.push(JSON.stringify(rec));
    this.pending.set(key, lines);
    this.schedule();
  }

  private isRecent(key: string): boolean {
    return dayStart(key) >= dayStart(dayKey(this.now())) - (CACHE_DAYS - 1) * DAY_MS;
  }

  private schedule(): void {
    const ms = this.d.flushMs ?? 500;
    if (ms <= 0) {
      this.flushSync();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private take(): Array<[string, string]> {
    const batch = [...this.pending.entries()].map(
      ([key, lines]) => [key, `${lines.join('\n')}\n`] as [string, string],
    );
    this.pending.clear();
    return batch;
  }

  /** 异步写出攒着的记录（按顺序串行，避免交错） */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.take();
    if (!batch.length) return this.writing;
    this.writing = this.writing.then(async () => {
      try {
        await fs.promises.mkdir(this.d.dir, { recursive: true, mode: 0o700 });
        for (const [key, data] of batch)
          await fs.promises.appendFile(this.file(key), data, { mode: 0o600 });
      } catch (e) {
        this.d.logger?.warn('quality ledger write failed', { error: (e as Error).message });
      }
    });
    return this.writing;
  }

  /** 退出时：同步写完 */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.take();
    if (!batch.length) return;
    try {
      fs.mkdirSync(this.d.dir, { recursive: true, mode: 0o700 });
      for (const [key, data] of batch) fs.appendFileSync(this.file(key), data, { mode: 0o600 });
    } catch (e) {
      this.d.logger?.warn('quality ledger write failed', { error: (e as Error).message });
    }
  }

  /** 读一天（含尚未写盘的部分）；坏行跳过 */
  private readDay(key: string): QualityRecord[] {
    const out: QualityRecord[] = [];
    let text = '';
    try {
      text = fs.readFileSync(this.file(key), 'utf8');
    } catch {
      /* 当天还没有记录 */
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const r = sanitizeRecord(JSON.parse(line));
        if (r) out.push(r);
      } catch {
        /* 写到一半的行（崩溃）：跳过 */
      }
    }
    for (const line of this.pending.get(key) ?? []) {
      const r = sanitizeRecord(JSON.parse(line));
      if (r) out.push(r);
    }
    return out;
  }

  /** [from, to) 内的全部记录（按天读取；最近 7 天走内存） */
  range(from: number, to: number): QualityRecord[] {
    const out: QualityRecord[] = [];
    if (!(to > from)) return out;
    for (let t = dayStart(dayKey(from)); t < to; t = dayStart(dayKey(t + DAY_MS + 3_600_000))) {
      const key = dayKey(t);
      let list = this.days.get(key);
      if (!list) {
        list = this.readDay(key);
        if (this.isRecent(key)) this.days.set(key, list);
      }
      for (const r of list) if (r.ts >= from && r.ts < to) out.push(r);
    }
    this.evict();
    return out;
  }

  /** 最近的 n 条（新的在前），用于「最近请求」 */
  recent(limit: number, maxDays = CACHE_DAYS): QualityRecord[] {
    const to = this.now() + 1;
    const all = this.range(to - maxDays * DAY_MS, to);
    return all.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  private evict(): void {
    for (const key of this.days.keys()) if (!this.isRecent(key)) this.days.delete(key);
  }

  /** 已有记录的日期（升序） */
  dayKeys(): string[] {
    try {
      return fs
        .readdirSync(this.d.dir)
        .map((n) => FILE_RE.exec(n)?.[1])
        .filter((k): k is string => !!k)
        .sort();
    } catch {
      return [];
    }
  }

  /** 删除超过保留天数的文件；返回删除的天数 */
  prune(retentionDays: number): number {
    const keep = dayStart(dayKey(this.now())) - (Math.max(1, retentionDays) - 1) * DAY_MS;
    let removed = 0;
    for (const key of this.dayKeys()) {
      if (dayStart(key) >= keep) continue;
      try {
        fs.rmSync(this.file(key), { force: true });
        this.days.delete(key);
        removed++;
      } catch (e) {
        this.d.logger?.warn('quality ledger prune failed', { error: (e as Error).message });
      }
    }
    return removed;
  }

  /** 一键清空：内存、待写与全部文件 */
  async clear(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    await this.writing;
    this.days.clear();
    for (const key of this.dayKeys()) fs.rmSync(this.file(key), { force: true });
  }

  dispose(): void {
    this.flushSync();
  }
}
