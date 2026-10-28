/**
 * 用量账本：本地 JSON Lines 文件（userData/usage/ledger.jsonl），只在本机，不上传。
 *
 * - 追加写；同一个 key 后写的一行覆盖先写的（用于 Claude 流式分段消息逐步写入的 usage）。
 * - 启动时整文件载入内存并压缩（去掉被覆盖的旧行 / 过期记录）；内存里按时间排序，查询走二分。
 *   小文件（≤ 1MB）在构造时同步载入；大文件改为后台分块读取解析，不挡启动（几万条约 100ms+），
 *   载入期间的写入先进内存，载入完成后与磁盘记录按 upsert 口径合并（不丢、不重复）。
 *   依赖完整数据的调用方（查询 IPC、日志扫描）先 await whenReady()。
 * - 压缩与定时落盘的游标文件走异步写：压缩分批序列化写临时文件，再在同一个 tick 里 rename 并补写
 *   快照之后变化的记录；同一时刻只有一个压缩在跑，期间再请求的合并成排队的一次。
 * - 保留时长：90 天 / 1 年 / 永久；过期记录在启动与每日整理时清掉。
 * - cursors.json：编程工具日志的增量读取游标（文件 → 已读字节数），避免每次全量重扫。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  ensureInheritedPrivateDirAsync,
  tightenWindowsAclAsync,
  writePrivateFile,
  writePrivateFileAtomicAsync,
} from '../utils/privateFile';

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

type Logger = { info?(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

/** 账本文件不超过这个大小就在构造时同步载入（几毫秒）；更大的改为后台分块载入 */
const SYNC_LOAD_MAX_BYTES = 1024 * 1024;
/** 后台载入每次读取的字节数（每块解析约几毫秒，块与块之间让出事件循环） */
const LOAD_CHUNK_BYTES = 1024 * 1024;
/** 压缩时每批序列化的记录数（每批写一次临时文件，期间主进程照常处理事件） */
const COMPACT_BATCH = 4000;
let tmpSeq = 0;

/**
 * 同一个 key 的两条记录合并（upsert 的口径）：token 只增不减，模型名只从 unknown 升级，
 * ts 取早的，计价分档只增不减；其余字段后写的覆盖。返回 null = 没有变化。
 */
function mergeRecord(prev: UsageRecord, r: UsageRecord): UsageRecord | null {
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
    return null;
  return merged;
}

/** 解析账本的一行；空行 / 半行 / 损坏行返回 null */
function parseLine(line: string): UsageRecord | null {
  if (!line) return null;
  try {
    const r = JSON.parse(line) as UsageRecord;
    return r && typeof r.key === 'string' && typeof r.ts === 'number' ? r : null;
  } catch {
    return null;
  }
}

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
  /**
   * 只含路由记录（via === 'route'）的按时间排序索引。扫描编程工具日志时每条日志记录都要查
   * routeCovering：原来走全量 snapshot()，而每次 upsert 都会让全量排序失效，导入日志时
   * 变成「每条记录重排整本账」（O(N² log N)），几十万条时主进程卡几秒。路由记录通常很少，单独索引。
   */
  private routeSorted: UsageRecord[] | null = null;
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
  /** 一键清空计数：后台载入 / 压缩开始时捕获，结束时对不上 = 期间被清空，磁盘快照作废 */
  private epoch = 0;
  /** 磁盘内容是否已载入内存（同步载入时构造完即为 true） */
  private loaded = false;
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;
  /** 载入期间请求的保留期清理：载入完成后再执行（只保留最后一次） */
  private pendingPrune: Retention | null = null;
  /** 载入期间删除的游标：合并磁盘游标时不再带回来 */
  private droppedDuringLoad = new Set<string>();
  /** 账本读失败（不是「文件不存在」）：内存里只有部分数据，本次运行不压缩，免得覆盖掉读不到的记录 */
  private noCompact = false;
  private closed = false;
  private compactRunning: Promise<void> | null = null;
  private compactQueued: Promise<void> | null = null;
  /** 游标版本：异步写完成时版本没变才算落盘；期间同步写过更新的版本则标脏，下一轮再写 */
  private cursorGen = 0;
  private cursorSyncGen = 0;
  private cursorWriting = false;

  constructor(
    private readonly d: {
      root: string;
      logger?: Logger;
      flushMs?: number;
      now?: () => number;
      /** 进入 / 退出落盘降级时回调（让界面及时显示「暂存在内存」，#42） */
      onPersistChange?: (degraded: boolean) => void;
      /** 同步载入的大小上限（字节）；更大的文件后台载入。缺省 1MB，测试可传 0 让非空文件走后台载入 */
      syncLoadMaxBytes?: number;
      /** 后台载入完成（磁盘记录已并入内存）时回调；同步载入时不调用 */
      onLoaded?: () => void;
    },
  ) {
    fs.mkdirSync(d.root, { recursive: true });
    this.file = path.join(d.root, 'ledger.jsonl');
    this.cursorFile = path.join(d.root, 'cursors.json');
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      /* 第一次运行 */
    }
    if (size <= (d.syncLoadMaxBytes ?? SYNC_LOAD_MAX_BYTES)) {
      this.ready = Promise.resolve();
      this.loadSync();
    } else {
      this.ready = new Promise<void>((resolve) => (this.markReady = resolve));
      void this.loadAsync(size);
    }
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private loadSync(): void {
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.noCompact = true;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      this.lines++;
      const r = parseLine(line);
      if (r) this.recs.set(r.key, r);
    }
    try {
      const c = JSON.parse(fs.readFileSync(this.cursorFile, 'utf8')) as Record<string, FileCursor>;
      if (c && typeof c === 'object') this.cursors = c;
    } catch {
      /* 没有游标 */
    }
    this.loaded = true;
    // 被覆盖的行占了一半以上就压缩一次
    if (this.lines > 1000 && this.lines > this.recs.size * 2) void this.compact();
  }

  /**
   * 后台载入：只读到开始时的文件大小（之后追加的行就是内存里已有的记录），按块解析，
   * 块与块之间是异步读，主进程照常处理事件。载入期间 upsert 的记录先只在内存里，完成后合并。
   */
  private async loadAsync(size: number): Promise<void> {
    const t0 = Date.now();
    const epoch = this.epoch;
    const disk = new Map<string, UsageRecord>();
    let lines = 0;
    let failed = false;
    try {
      const stream = fs.createReadStream(this.file, {
        encoding: 'utf8',
        start: 0,
        end: size - 1,
        highWaterMark: LOAD_CHUNK_BYTES,
      });
      let rest = '';
      for await (const chunk of stream as AsyncIterable<string>) {
        const text = rest + chunk;
        let from = 0;
        for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', from)) {
          const line = text.slice(from, nl);
          from = nl + 1;
          if (!line) continue;
          lines++;
          const r = parseLine(line);
          if (r) disk.set(r.key, r);
        }
        rest = text.slice(from);
      }
      if (rest) {
        lines++;
        const r = parseLine(rest);
        if (r) disk.set(r.key, r);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed = true;
        this.d.logger?.warn('usage ledger load failed', String(e));
      }
    }
    let diskCursors: Record<string, FileCursor> = {};
    try {
      const c = JSON.parse(await fsp.readFile(this.cursorFile, 'utf8')) as Record<
        string,
        FileCursor
      >;
      if (c && typeof c === 'object') diskCursors = c;
    } catch {
      /* 没有游标 */
    }
    // 读失败：丢掉读了一半的数据（不当真），也不压缩，免得把读不到的部分从磁盘上抹掉
    if (failed) {
      this.noCompact = true;
      disk.clear();
      lines = 0;
    }
    // 期间被一键清空：磁盘上的旧记录不要了（清空之后写入的保留）
    if (epoch !== this.epoch) {
      disk.clear();
      lines = 0;
    }
    this.adopt(disk, lines, diskCursors);
    this.d.logger?.info?.('usage ledger loaded', {
      records: this.recs.size,
      lines,
      ms: Date.now() - t0,
    });
  }

  /** 把后台载入的磁盘内容并入内存：磁盘在前，载入期间的写入按 upsert 口径叠在上面 */
  private adopt(
    disk: Map<string, UsageRecord>,
    lines: number,
    diskCursors: Record<string, FileCursor>,
  ): void {
    for (const [k, r] of this.recs) {
      const prev = disk.get(k);
      if (!prev) {
        disk.set(k, r);
        continue;
      }
      disk.set(k, mergeRecord(prev, r) ?? prev);
      // 载入期间可能已经把内存里那份（不含磁盘部分）追加过：合并后的再写一行盖过它
      this.dirty.add(k);
    }
    this.recs = disk;
    this.lines += lines;
    this.sorted = null;
    this.routeSorted = null;
    this.ver++;
    for (const p of this.droppedDuringLoad) delete diskCursors[p];
    this.droppedDuringLoad.clear();
    if (Object.keys(this.cursors).length) {
      this.cursors = { ...diskCursors, ...this.cursors };
      this.cursorGen++;
    } else {
      this.cursors = diskCursors;
    }
    this.loaded = true;
    this.markReady();
    let pruned = false;
    if (this.pendingPrune) {
      const r = this.pendingPrune;
      this.pendingPrune = null;
      pruned = this.prune(r) > 0;
    }
    if (!pruned && this.lines > 1000 && this.lines > this.recs.size * 2) void this.compact();
    if (this.dirty.size || this.cursorDirty) this.scheduleFlush();
    this.d.onLoaded?.();
  }

  /** 磁盘内容已全部载入后 resolve（同步载入时立即 resolve） */
  whenReady(): Promise<void> {
    return this.ready;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  size(): number {
    return this.recs.size;
  }

  /** 写入 / 更新一条记录；返回 true = 新增或有变化 */
  upsert(r: UsageRecord): boolean {
    const prev = this.recs.get(r.key);
    if (prev) {
      // 同一次调用的后续分段：token 只增不减。模型名只从 unknown 升级到真实 id，不回退。
      const merged = mergeRecord(prev, r);
      if (!merged) return false;
      r = merged;
    }
    if (r.via === 'route' || prev?.via === 'route') this.routeSorted = null;
    this.recs.set(r.key, r);
    this.placeInSorted(prev, r);
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
    if (prev.via === 'route') this.routeSorted = null;
    this.recs.set(key, next);
    this.placeInSorted(prev, next);
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
   * 增量维护排好序的视图，避免每次写入都让下一次查询整本重排：
   * 新记录不早于末尾 → 直接追加；更新且时间没变 → 原位替换；其它情况才作废重排。
   */
  private placeInSorted(prev: UsageRecord | undefined, next: UsageRecord): void {
    const arr = this.sorted;
    if (!arr) return;
    if (!prev) {
      if (!arr.length || arr[arr.length - 1]!.ts <= next.ts) arr.push(next);
      else this.sorted = null;
      return;
    }
    if (prev.ts === next.ts) {
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid]!.ts < prev.ts) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < arr.length && arr[i]!.ts === prev.ts; i++)
        if (arr[i] === prev) {
          arr[i] = next;
          return;
        }
    }
    this.sorted = null;
  }

  private routeSnapshot(): UsageRecord[] {
    if (!this.routeSorted) {
      const out: UsageRecord[] = [];
      for (const r of this.recs.values()) if (r.via === 'route') out.push(r);
      this.routeSorted = out.sort((a, b) => a.ts - b.ts);
    }
    return this.routeSorted;
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
    const arr = this.routeSnapshot();
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
    this.cursorGen++;
    this.droppedDuringLoad.delete(p);
    this.scheduleFlush();
  }

  dropCursor(p: string): void {
    if (!this.loaded) this.droppedDuringLoad.add(p);
    if (this.cursors[p]) {
      delete this.cursors[p];
      this.cursorDirty = true;
      this.cursorGen++;
    }
  }

  cursorPaths(): string[] {
    return Object.keys(this.cursors);
  }

  // ---------------------------------------------------------------- 保留与清空
  /** 删除早于保留期的记录；返回删除条数（后台载入期间先记下，载入完成后再清理，返回 0） */
  prune(retention: Retention): number {
    if (!this.loaded) {
      this.pendingPrune = retention;
      return 0;
    }
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
      this.routeSorted = null;
      this.ver++;
      void this.compact();
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
    this.routeSorted = null;
    this.ver++;
    this.epoch++; // 进行中的后台载入 / 压缩据此作废
    this.dirty.clear();
    this.appendTainted = false;
    this.lines = 0;
    try {
      writePrivateFile(this.file, '');
    } catch (e) {
      this.d.logger?.warn('usage clear failed', String(e));
    }
  }

  /**
   * 把内存状态整体写回（去掉被覆盖的旧行）。异步：分批序列化写临时文件，主进程不卡；
   * 同一时刻只跑一个，运行中再请求的合并成排队的一次（载入完成前请求的排在载入之后）。
   * 返回的 Promise 在这次（或排队的那次）压缩结束后 resolve，失败只记 warn，不会 reject。
   */
  compact(): Promise<void> {
    if (this.compactQueued) return this.compactQueued;
    const start = (): Promise<void> => {
      this.compactQueued = null;
      const run = this.runCompact().finally(() => {
        if (this.compactRunning === run) this.compactRunning = null;
      });
      this.compactRunning = run;
      return run;
    };
    const before = this.compactRunning ?? (this.loaded ? null : this.ready);
    if (!before) return start();
    this.compactQueued = before.catch(() => undefined).then(start);
    return this.compactQueued;
  }

  private async runCompact(): Promise<void> {
    if (this.closed || this.noCompact) return;
    const epoch = this.epoch;
    // 引用快照：记录对象只会被整条替换、不会原地修改，之后的变化靠对比引用找出来
    const snap = this.snapshot().slice();
    const tmp = `${this.file}.${process.pid}.${++tmpSeq}.tmp`;
    let fh: fsp.FileHandle | null = null;
    try {
      // Windows：账本目录（userData/usage）是自动收紧的私有目录时，新建的临时文件继承私有 ACL，
      // 不用逐文件 icacls；目录收紧不了才在 rename 前异步收紧临时文件（不挡主进程）
      const inherits = await ensureInheritedPrivateDirAsync(path.dirname(this.file));
      // 同名残留（崩溃后同 pid 复用序号）会沿用旧 ACL：先删掉，保证下面是新建
      if (inherits) await fsp.rm(tmp, { force: true }).catch(() => undefined);
      fh = await fsp.open(tmp, 'w', 0o600);
      for (let i = 0; i < snap.length; i += COMPACT_BATCH) {
        if (this.closed || epoch !== this.epoch) break;
        let chunk = '';
        const end = Math.min(i + COMPACT_BATCH, snap.length);
        for (let j = i; j < end; j++) chunk += `${JSON.stringify(snap[j])}\n`;
        await fh.writeFile(chunk); // 写满为止（write 可能只写一部分）
      }
      await fh.close();
      fh = null;
      if (!inherits) await tightenWindowsAclAsync(tmp, 'file');
      // 写临时文件 / 收紧期间被清空 / 服务已停止：这份快照过时了，放弃（原文件 + 追加的行仍完整）
      if (this.closed || epoch !== this.epoch) {
        await fsp.rm(tmp, { force: true }).catch(() => undefined);
        return;
      }
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {
        /* Windows 等平台忽略 */
      }
      // rename 与下面的补写放在同一个 tick（之间不能有 await）
      fs.renameSync(tmp, this.file);
    } catch (e) {
      await fh?.close().catch(() => undefined);
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      this.d.logger?.warn('usage compact failed', String(e));
      return;
    }
    // rename 之后同一个 tick 里：快照之后新增 / 变化的记录（期间可能已追加到旧文件、随 rename 丢了）
    // 重新排队并立即追加，新文件不缺数据
    const inSnap = new Set(snap);
    const next = new Set<string>();
    for (const [k, r] of this.recs) if (!inSnap.has(r)) next.add(k);
    this.dirty = next;
    this.appendTainted = false;
    this.lines = snap.length;
    if (this.dirty.size) {
      const failed = this.appendDirty();
      if (failed) this.settle(failed);
    }
    // 游标等这次压缩收尾（compactRunning 清掉）后由定时落盘写
    if (this.dirty.size || this.cursorDirty) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSoon();
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

  /** 追加待写记录（同步追加，单次通常只有几 KB）；成功后才摘掉对应的待写键。返回失败原因 */
  private appendDirty(): unknown {
    if (!this.dirty.size) return null;
    const keys = [...this.dirty];
    const body = keys
      .map((k) => this.recs.get(k))
      .filter((r): r is UsageRecord => !!r)
      .map((r) => JSON.stringify(r))
      .join('\n');
    if (!body) {
      this.dirty.clear();
      return null;
    }
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
      return null;
    } catch (e) {
      this.appendTainted = true;
      return e;
    }
  }

  /** 游标能不能落盘：已载入完磁盘游标（否则会盖掉磁盘上的），且没有待写记录 */
  private cursorWritable(): boolean {
    return this.loaded && !this.dirty.size && this.cursorDirty;
  }

  private settle(failed: unknown): void {
    const was = this.degraded;
    if (failed) {
      if (!this.degraded) this.d.logger?.warn('usage flush failed', String(failed));
      this.degraded = true;
      this.scheduleFlush(); // 存储恢复后自动重试
    } else {
      this.degraded = false;
    }
    if (was !== this.degraded) this.d.onPersistChange?.(this.degraded);
  }

  /**
   * 定时落盘：记录照常同步追加；游标文件（可能几百 KB）走异步原子写，不挡主进程。
   * 游标只在没有待写记录时才写（持久游标不能越过未持久化的记录）。
   */
  private flushSoon(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const failed = this.appendDirty();
    if (failed) {
      this.settle(failed);
      return;
    }
    // 压缩进行中先不写：rename 前追加到旧文件的记录要等 rename 后补写才算稳（压缩结束会再调这里）
    if (this.cursorWritable() && !this.compactRunning && !this.cursorWriting) {
      void this.writeCursorsAsync();
      return;
    }
    this.settle(null);
  }

  private async writeCursorsAsync(): Promise<void> {
    const gen = this.cursorGen;
    this.cursorWriting = true;
    let failed: unknown = null;
    try {
      await writePrivateFileAtomicAsync(this.cursorFile, JSON.stringify(this.cursors));
    } catch (e) {
      failed = e;
    }
    this.cursorWriting = false;
    // 等待期间同步写过更新的游标、又被这次较旧的盖掉了：较旧的游标只会让日志多读一点（同键去重），
    // 不会越过已落盘的记录；标脏，下一轮用内存里的最新值再写
    if (!failed) {
      if (this.cursorSyncGen > gen) this.cursorDirty = true;
      else if (this.cursorGen === gen) this.cursorDirty = false;
    }
    this.settle(failed);
    if (!failed && this.cursorDirty) this.scheduleFlush();
  }

  /**
   * 立即同步落盘（退出时 / 测试）：先追加记录，成功后才摘掉对应的待写键；游标只在没有待写记录时才写
   * （持久游标不能越过未持久化的记录，否则重启后日志被判定「已读」而账本里没有）。
   * 任一步失败都保留全部可重试状态并安排重试。
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    let failed = this.appendDirty();
    if (!failed && this.cursorWritable()) {
      try {
        writePrivateFile(this.cursorFile, JSON.stringify(this.cursors));
        this.cursorSyncGen = this.cursorGen;
        this.cursorDirty = false;
      } catch (e) {
        failed = e;
      }
    }
    this.settle(failed);
  }

  /** 停止：同步落盘，之后不再压缩（进行中的压缩放弃，不会盖掉刚追加的记录） */
  close(): void {
    this.closed = true;
    this.flush();
  }
}
