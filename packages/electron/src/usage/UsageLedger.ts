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
  /** 文件身份（dev / inode；Windows 上取不到时缺省）：换了文件（rename 替换 / 恢复备份）就丢弃游标 */
  dev?: number;
  ino?: number;
  /** 已消费区域末尾（至多 fpLen 字节）的 sha1：原地重写 / 等长替换时内容对不上就从头读 */
  fp?: string;
  fpLen?: number;
  /** 各解析器自己的续读状态（Codex：当前模型 / 上一次累计值等） */
  state?: Record<string, unknown>;
}

type Logger = { warn(m: string, d?: unknown): void };

/** 路由请求与日志记录的去重窗口：日志时间落在 [路由开始 - SLACK, 路由结束 + SLACK] 内视为同一次 */
const ROUTE_SLACK_MS = 15_000;
/** 无共享 id 时，路由记录与日志记录的提示词 token 允许的差异（相对 / 绝对取大者） */
const PROMPT_TOL_REL = 0.1;
const PROMPT_TOL_ABS = 16;

/** 日志记录的身份，用来判断它是不是某条路由记录的同一次请求 */
export interface RouteHint {
  key: string;
  session?: string;
  /** 输入 + 缓存读写 */
  prompt: number;
  output: number;
}

/** 日志键以上游响应 id 结尾（`claude:<id>` / `claude:<会话>:<id>`）= 同一次请求 */
function sameRequestId(logKey: string, rid: string): boolean {
  return logKey === rid || logKey.endsWith(`:${rid}`);
}

export class UsageLedger {
  private readonly file: string;
  private readonly cursorFile: string;
  private recs = new Map<string, UsageRecord>();
  /** 按 ts 升序的快照（查询用；脏了再重建） */
  private sorted: UsageRecord[] | null = null;
  private cursors: Record<string, FileCursor> = {};
  /**
   * 还没落盘的记录键。只存键、落盘时取内存里的最新值：写失败时队列不丢，
   * 且长时间写不进去也只会占 O(记录数) 内存（同键多次更新合并为一条）。
   */
  private dirty = new Set<string>();
  /** 上一次追加写失败过：可能留下半行，下一次追加先补一个换行把残行隔开（load 会忽略空行 / 坏行） */
  private appendTainted = false;
  private degraded = false;
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
      // 同一次调用的后续分段：token 只增不减。模型名只从 unknown 升级到真实 id，不回退。
      const model = r.model && r.model !== 'unknown' ? r.model : prev.model;
      const merged: UsageRecord = {
        ...prev,
        ...r,
        model,
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
        !!merged.fast === !!prev.fast &&
        merged.model === prev.model
      )
        return false;
      r = merged;
    }
    this.recs.set(r.key, r);
    this.sorted = null;
    this.ver++;
    this.dirty.add(r.key);
    this.lines++;
    this.scheduleFlush();
    return true;
  }

  /** 内容版本号：每次写入 / 清空 / 清理都会变，用来判断派生缓存是否过期 */
  version(): number {
    return this.ver;
  }

  /**
   * 给已有记录补缺的字段（不改 token）：会话 / 项目，以及计价分档 cacheWrite1h / fast
   * （同一次调用的日志比路由嗅探拆得更细时，用来补齐费用口径；只增不减，1h 档不超过缓存写总量）。
   * 返回 true = 有变化。
   */
  attribute(
    key: string,
    patch: {
      session?: string;
      project?: string;
      cacheWrite1h?: number;
      fast?: boolean;
      /** 认领这条路由记录的日志键（只在还没被认领时写入） */
      logKey?: string;
    },
  ): boolean {
    const prev = this.recs.get(key);
    if (!prev) return false;
    const next: UsageRecord = { ...prev };
    if (!prev.session && patch.session) next.session = patch.session;
    if (!prev.project && patch.project) next.project = patch.project;
    const w1h = Math.min(
      Math.max(prev.cacheWrite1h ?? 0, patch.cacheWrite1h ?? 0),
      prev.cacheWrite,
    );
    if (w1h > (prev.cacheWrite1h ?? 0)) next.cacheWrite1h = w1h;
    if (patch.fast && !prev.fast) next.fast = true;
    if (patch.logKey && !prev.logKey) next.logKey = patch.logKey;
    if (
      next.session === prev.session &&
      next.project === prev.project &&
      next.cacheWrite1h === prev.cacheWrite1h &&
      next.fast === prev.fast &&
      next.logKey === prev.logKey
    )
      return false;
    this.recs.set(key, next);
    this.sorted = null;
    this.ver++;
    this.dirty.add(key);
    this.lines++;
    this.scheduleFlush();
    return true;
  }

  has(key: string): boolean {
    return this.recs.has(key);
  }

  get(key: string): UsageRecord | undefined {
    return this.recs.get(key);
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

  /** 某个来源最近一条记录的时间（没有返回 null；从最新往回找，不拷贝整本账） */
  lastTs(source: string): number | null {
    const arr = this.snapshot();
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i]!.source === source) return arr[i]!.ts;
    return null;
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
   *
   * 不带 hint：只看来源 + 时间窗口（旧口径，返回第一个匹配）。
   * 带 hint（日志记录的身份）时必须是同一次请求才算：
   * 1. 稳定 id 联结：路由记录的键 / 上游响应 id 与日志键相同 → 精确匹配；
   * 2. 路由已被另一条日志认领（logKey）→ 不能再并入（一对一）；
   * 3. 两边都是 Anthropic msg_… 而 id 不同 → 不是同一次；会话 id 都有但不同 → 不是同一次；
   * 4. 提示词 token（输入 + 缓存读写）要接近，日志输出不能明显超过路由输出；
   * 5. 多个都满足时取 token 最接近、时间最近的一个。
   * 没有唯一可信的匹配就返回 null，让日志记录照常入账（宁可保留待核对的记录，也不吞掉独立请求）。
   */
  routeCovering(source: UsageSource, ts: number, hint?: RouteHint): UsageRecord | null {
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
    let best: { r: UsageRecord; score: number } | null = null;
    for (let i = lo; i < arr.length && arr[i]!.ts <= ts + ROUTE_SLACK_MS; i++) {
      const r = arr[i]!;
      if (r.via !== 'route' || r.source !== source) continue;
      if (ts < r.ts - ROUTE_SLACK_MS || ts > r.ts + (r.dur ?? 0) + ROUTE_SLACK_MS) continue;
      if (!hint) return r;
      if (r.key === hint.key || (r.rid && sameRequestId(hint.key, r.rid))) return r;
      if (r.logKey) {
        if (r.logKey === hint.key) return r;
        continue;
      }
      if (r.rid?.startsWith('msg_') && hint.key.startsWith('claude:msg_')) continue;
      if (r.session && hint.session && r.session !== hint.session) continue;
      const rp = r.input + r.cacheRead + r.cacheWrite;
      const dp = Math.abs(rp - hint.prompt);
      if (dp > Math.max(PROMPT_TOL_ABS, rp * PROMPT_TOL_REL)) continue;
      if (hint.output > r.output + Math.max(PROMPT_TOL_ABS, r.output * PROMPT_TOL_REL)) continue;
      const score = dp + Math.abs(r.output - hint.output) + Math.abs(ts - r.ts) / 1000;
      if (!best || score < best.score) best = { r, score };
    }
    return best?.r ?? null;
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
    this.dirty.clear();
    this.appendTainted = false;
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
      this.dirty.clear();
      this.appendTainted = false;
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

  /** 落盘状态：degraded = 最近一次写盘失败，记录 / 游标还留在内存里等待重试 */
  persistState(): { degraded: boolean; pendingRecords: number; cursorDirty: boolean } {
    return {
      degraded: this.degraded,
      pendingRecords: this.dirty.size,
      cursorDirty: this.cursorDirty,
    };
  }

  /**
   * 落盘：先追加记录，成功后才摘掉对应的待写键；游标只在没有待写记录时才写
   * （持久游标不能越过未持久化的记录，否则重启后日志被判定「已读」而账本里没有）。
   * 任一步失败都保留全部可重试状态并安排重试。
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    let failed: unknown = null;
    if (this.dirty.size) {
      const keys = [...this.dirty];
      const body = keys
        .map((k) => this.recs.get(k))
        .filter((r): r is UsageRecord => !!r)
        .map((r) => JSON.stringify(r))
        .join('\n');
      if (!body) {
        this.dirty.clear();
      } else {
        try {
          const fresh = !fs.existsSync(this.file);
          fs.appendFileSync(this.file, `${this.appendTainted ? '\n' : ''}${body}\n`, {
            mode: 0o600,
          });
          this.appendTainted = false;
          for (const k of keys) this.dirty.delete(k);
          if (fresh) {
            try {
              fs.chmodSync(this.file, 0o600);
            } catch {
              /* Windows */
            }
          }
        } catch (e) {
          failed = e;
          this.appendTainted = true;
        }
      }
    }
    if (!failed && !this.dirty.size && this.cursorDirty) {
      try {
        writePrivateFile(this.cursorFile, JSON.stringify(this.cursors));
        this.cursorDirty = false;
      } catch (e) {
        failed = e;
      }
    }
    if (failed) {
      if (!this.degraded) this.d.logger?.warn('usage flush failed', String(failed));
      this.degraded = true;
      this.scheduleFlush(); // 存储恢复后自动重试
    } else {
      this.degraded = false;
    }
  }
}
