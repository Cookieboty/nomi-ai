/**
 * 用量账本：本地 JSON Lines 文件（userData/usage/ledger.jsonl），只在本机，不上传。
 *
 * - 追加写；同一个 key 后写的一行覆盖先写的（用于 Claude 流式分段消息逐步写入的 usage）。
 * - 启动时整文件载入内存并压缩（去掉被覆盖的旧行 / 过期记录）；内存里按时间排序，查询走二分。
 * - 保留时长：90 天 / 1 年 / 永久；过期记录在启动与每日整理时清掉。
 * - cursors.json：编程工具日志的增量读取游标（文件 → 已读字节数），避免每次全量重扫。
 */
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFile } from '../utils/privateFile';

import type { UsageRecord, UsageSource } from './types';

export type Retention = '90d' | '1y' | 'forever';

export const RETENTION_MS: Record<Retention, number> = {
  '90d': 90 * 86_400_000,
  '1y': 365 * 86_400_000,
  forever: Infinity,
};

export interface FileCursor {
  /** 已处理到的字节偏移（只前进到最后一个完整行的末尾） */
  offset: number;
  /** 上次看到的文件大小 / mtime，用来识别被截断或替换 */
  size: number;
  mtimeMs: number;
  /** 各解析器自己的续读状态（Codex：当前模型 / 上一次累计值等） */
  state?: Record<string, unknown>;
}

type Logger = { warn(m: string, d?: unknown): void };

/** 路由请求与日志记录的去重窗口：日志时间落在 [路由开始 - SLACK, 路由结束 + SLACK] 内视为同一次 */
const ROUTE_SLACK_MS = 15_000;

export class UsageLedger {
  private readonly file: string;
  private readonly cursorFile: string;
  private recs = new Map<string, UsageRecord>();
  /** 按 ts 升序的快照（查询用；脏了再重建） */
  private sorted: UsageRecord[] | null = null;
  private cursors: Record<string, FileCursor> = {};
  private pending: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorDirty = false;
  private lines = 0;
  /** 内容变化计数（派生缓存用） */
  private ver = 0;

  constructor(
    private readonly d: { root: string; logger?: Logger; flushMs?: number; now?: () => number },
  ) {
    fs.mkdirSync(d.root, { recursive: true });
    this.file = path.join(d.root, 'ledger.jsonl');
    this.cursorFile = path.join(d.root, 'cursors.json');
    this.load();
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private load(): void {
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      /* 第一次运行 */
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      this.lines++;
      try {
        const r = JSON.parse(line) as UsageRecord;
        if (r && typeof r.key === 'string' && typeof r.ts === 'number') this.recs.set(r.key, r);
      } catch {
        /* 半行 / 损坏行：忽略 */
      }
    }
    try {
      const c = JSON.parse(fs.readFileSync(this.cursorFile, 'utf8')) as Record<string, FileCursor>;
      if (c && typeof c === 'object') this.cursors = c;
    } catch {
      /* 没有游标 */
    }
    // 被覆盖的行占了一半以上就压缩一次
    if (this.lines > 1000 && this.lines > this.recs.size * 2) this.compact();
  }

  size(): number {
    return this.recs.size;
  }

  /** 写入 / 更新一条记录；返回 true = 新增或有变化 */
  upsert(r: UsageRecord): boolean {
    const prev = this.recs.get(r.key);
    if (prev) {
      // 同一次调用的后续分段：token 只增不减
      const merged: UsageRecord = {
        ...prev,
        ...r,
        input: Math.max(prev.input, r.input),
        output: Math.max(prev.output, r.output),
        cacheRead: Math.max(prev.cacheRead, r.cacheRead),
        cacheWrite: Math.max(prev.cacheWrite, r.cacheWrite),
        ts: Math.min(prev.ts, r.ts),
      };
      // 新增字段：缺省 = 旧口径；有任何一边带值就取较大 / 较晚声明的（只增不减）
      const w1h = Math.max(prev.cacheWrite1h ?? 0, r.cacheWrite1h ?? 0);
      if (w1h) merged.cacheWrite1h = w1h;
      else delete merged.cacheWrite1h;
      if (prev.fast || r.fast) merged.fast = true;
      else delete merged.fast;
      if (
        merged.input === prev.input &&
        merged.output === prev.output &&
        merged.cacheRead === prev.cacheRead &&
        merged.cacheWrite === prev.cacheWrite &&
        (merged.cacheWrite1h ?? 0) === (prev.cacheWrite1h ?? 0) &&
        !!merged.fast === !!prev.fast
      )
        return false;
      r = merged;
    }
    this.recs.set(r.key, r);
    this.sorted = null;
    this.ver++;
    this.pending.push(JSON.stringify(r));
    this.lines++;
    this.scheduleFlush();
    return true;
  }

  /** 内容版本号：每次写入 / 清空 / 清理都会变，用来判断派生缓存是否过期 */
  version(): number {
    return this.ver;
  }

  /** 给已有记录补会话 / 项目（只补缺的字段，不改 token）；返回 true = 有变化 */
  attribute(key: string, patch: { session?: string; project?: string }): boolean {
    const prev = this.recs.get(key);
    if (!prev) return false;
    const next: UsageRecord = { ...prev };
    if (!prev.session && patch.session) next.session = patch.session;
    if (!prev.project && patch.project) next.project = patch.project;
    if (next.session === prev.session && next.project === prev.project) return false;
    this.recs.set(key, next);
    this.sorted = null;
    this.ver++;
    this.pending.push(JSON.stringify(next));
    this.lines++;
    this.scheduleFlush();
    return true;
  }

  has(key: string): boolean {
    return this.recs.has(key);
  }

  /** 按时间范围取记录（升序） */
  range(from: number, to: number): UsageRecord[] {
    const arr = this.snapshot();
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]!.ts < from) lo = mid + 1;
      else hi = mid;
    }
    const out: UsageRecord[] = [];
    for (let i = lo; i < arr.length && arr[i]!.ts < to; i++) out.push(arr[i]!);
    return out;
  }

  all(): UsageRecord[] {
    return this.snapshot().slice();
  }

  private snapshot(): UsageRecord[] {
    if (!this.sorted) this.sorted = [...this.recs.values()].sort((a, b) => a.ts - b.ts);
    return this.sorted;
  }

  /**
   * 编程工具日志里的这条记录，是不是已经由 Nomi 本地路由记过账？
   * （走本地路由的请求，日志里也有一份；以路由的为准，日志的跳过，避免重复计数）
   */
  routeCovering(source: UsageSource, ts: number): UsageRecord | null {
    const arr = this.snapshot();
    // 找到第一个 ts >= 窗口左界的路由记录
    const left = ts - ROUTE_SLACK_MS - 10 * 60_000; // 路由单次最长按 10 分钟估
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]!.ts < left) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < arr.length && arr[i]!.ts <= ts + ROUTE_SLACK_MS; i++) {
      const r = arr[i]!;
      if (r.via !== 'route' || r.source !== source) continue;
      if (ts >= r.ts - ROUTE_SLACK_MS && ts <= r.ts + (r.dur ?? 0) + ROUTE_SLACK_MS) return r;
    }
    return null;
  }

  coveredByRoute(source: UsageSource, ts: number): boolean {
    return this.routeCovering(source, ts) !== null;
  }

  // ---------------------------------------------------------------- 游标
  cursor(p: string): FileCursor | undefined {
    return this.cursors[p];
  }

  setCursor(p: string, c: FileCursor): void {
    this.cursors[p] = c;
    this.cursorDirty = true;
    this.scheduleFlush();
  }

  dropCursor(p: string): void {
    if (this.cursors[p]) {
      delete this.cursors[p];
      this.cursorDirty = true;
    }
  }

  cursorPaths(): string[] {
    return Object.keys(this.cursors);
  }

  // ---------------------------------------------------------------- 保留与清空
  /** 删除早于保留期的记录；返回删除条数 */
  prune(retention: Retention): number {
    const keep = RETENTION_MS[retention];
    if (!Number.isFinite(keep)) return 0;
    const cutoff = this.now() - keep;
    let n = 0;
    for (const [k, r] of this.recs) {
      if (r.ts < cutoff) {
        this.recs.delete(k);
        n++;
      }
    }
    if (n) {
      this.sorted = null;
      this.ver++;
      this.compact();
    }
    return n;
  }

  /**
   * 一键清空：记录全部删除。游标保留（日志不会被重新导入）；
   * 清空时刻之前的日志内容由 UsageLogScanner 按 clearedAt 过滤掉。
   */
  clear(): void {
    this.recs.clear();
    this.sorted = null;
    this.ver++;
    this.pending = [];
    this.lines = 0;
    try {
      writePrivateFile(this.file, '');
    } catch (e) {
      this.d.logger?.warn('usage clear failed', String(e));
    }
  }

  /** 把内存状态整体写回（去掉被覆盖的旧行） */
  compact(): void {
    try {
      const body = this.snapshot()
        .map((r) => JSON.stringify(r))
        .join('\n');
      const tmp = `${this.file}.tmp`;
      writePrivateFile(tmp, body ? `${body}\n` : '');
      fs.renameSync(tmp, this.file);
      this.pending = [];
      this.lines = this.recs.size;
    } catch (e) {
      this.d.logger?.warn('usage compact failed', String(e));
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.d.flushMs ?? 1500);
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      if (this.pending.length) {
        const chunk = `${this.pending.join('\n')}\n`;
        this.pending = [];
        const fresh = !fs.existsSync(this.file);
        fs.appendFileSync(this.file, chunk, { mode: 0o600 });
        if (fresh) {
          try {
            fs.chmodSync(this.file, 0o600);
          } catch {
            /* Windows */
          }
        }
      }
      if (this.cursorDirty) {
        this.cursorDirty = false;
        writePrivateFile(this.cursorFile, JSON.stringify(this.cursors));
      }
    } catch (e) {
      this.d.logger?.warn('usage flush failed', String(e));
    }
  }
}
