/**
 * 读取本机已安装编程工具自己的会话日志，补齐「不经过 Nomi」的用量。
 *
 * - 增量游标：jsonl 记住已读字节偏移，只读新增的完整行；文件变小 / 被替换才从头读。
 * - 整份 JSON / zstd 压缩的会话（Gemini、dsh）：按 size+mtime 判断是否变化，变了再整份解析（键去重）。
 * - 去重：记录带稳定键（消息 id / 累计值 / seq），账本同键只记一次；
 *   走了 Nomi 本地路由的请求以路由记录为准，日志里同一时段的同来源记录跳过。
 * - 首次扫描只看保留期内修改过的文件；每轮扫描让出事件循环，不卡主进程。
 * - 找文件走异步遍历（并发上限）；目录 mtime 没变就复用上一轮的目录列表。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { zstdDecode } from '../cli/SessionHistoryService';

import {
  claudeConfigDir,
  codexHomeDir,
  copilotDir,
  geminiDir,
  grokHomeDir,
  kimiDirs,
  opencodeDir,
  qwenDir,
} from './cliHomes';
import {
  parseAiderChunk,
  parseClaudeChunk,
  parseCodexChunk,
  parseCodexRateLimits,
  parseDshChunk,
  parseGrokChunk,
  parseGeminiFile,
  parseKimiChunk,
  parseQwenChunk,
  copilotRowToRecord,
  opencodeRowToRecord,
  type ParseState,
} from './logParsers';
import type { QuotaWindow } from './quota';
import { DB_BATCH, dbSignature, readCopilotRows, readOpencodeRows } from './sqliteRead';
import type { UsageRecord, UsageSource } from './types';
import { RETENTION_MS, type FileCursor, type Retention, type UsageLedger } from './UsageLedger';

type Logger = { info?(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

/** Grok 日志改读 usage.modelUsage 后，旧游标里的 unknown 要整文件重读一次。 */
const GROK_LOG_REV = 2;
/** 单个文件一轮最多读多少字节（超大日志分多轮追平，避免一次占太多内存） */
const READ_CHUNK = 256 * 1024;
const MAX_READ_PER_PASS = 8 * 1024 * 1024;
/** 整份解析（JSON / zstd）的体积上限 */
const MAX_WHOLE_FILE = 64 * 1024 * 1024;
const MAX_FILES_PER_KIND = 5000;
/** 没有保留期上限（永久）时，首次导入最多回看多久 */
const MAX_LOOKBACK_MS = 400 * 86_400_000;

export interface ScannerDeps {
  ledger: UsageLedger;
  home?: string;
  dshHome?: string;
  grokHome?: string;
  /** 环境变量（测试注入）：CODEX_HOME / KIMI_HOME / OPENCODE_HOME … 默认 process.env */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  logger?: Logger;
  /** 当前保留期：决定首次导入回看多久 */
  retention: () => Retention;
  /** 早于这个时间的记录不导入（一键清空的时刻） */
  clearedAt?: () => number;
  /** 这个来源现在有路由请求在飞：先别读它的日志（等路由记完账再说，避免同一次请求记两份） */
  routeBusy?: (source: UsageSource) => boolean;
  /** 新增 / 更新了一条记录（预算 / 单任务提醒用） */
  onNew?: (r: UsageRecord) => void;
  /** 读到 Codex 日志里的额度快照（只在日志里确实有时触发） */
  onQuota?: (q: { ts: number; windows: QuotaWindow[]; plan?: string }) => void;
}

interface Found {
  source: UsageSource;
  path: string;
  mtime: number;
  /** jsonl = 增量按行读；whole = 整份解析；db = 只读 SQLite（只 SELECT 记账列） */
  mode: 'jsonl' | 'whole' | 'db';
}

async function statOf(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

/** 遍历最多看多少个目录项（与旧的同步实现一致：超过后不再进入新目录） */
const MAX_WALK_ENTRIES = 50_000;
/** 遍历时同时进行的 stat / readdir 数（走 libuv 线程池，不占主线程） */
const WALK_CONCURRENCY = 16;
/**
 * 目录 mtime 离「列目录的时刻」太近时不缓存列表：同一时间刻度里紧接着新建的文件不会再改 mtime，
 * 缓存下来就会一直看不到它（同 git 的 racy 判定）。
 */
const DIR_CACHE_RACY_MS = 2000;

interface DirEnt {
  name: string;
  dir: boolean;
  file: boolean;
}

/** 目录列表缓存：目录 mtime / inode 没变 = 子项没有增删改名，直接复用，不再 readdir */
interface DirListing {
  mtimeMs: number;
  ino: number;
  ents: DirEnt[];
}

/** 并发上限：超过的任务排队，前面的完成一个再放一个 */
export function createLimiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= n) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

/**
 * 异步遍历（fs.promises + 并发上限）。结果与旧的同步深度优先遍历一致：子目录列表可以提前并发去取，
 * 但仍按原顺序深度优先消费，50k 目录项的上限也按同样的顺序计数；候选文件最后再并发 stat。
 * 文件本身仍要 stat：往文件里追加内容不会改目录的 mtime。
 */
export async function walkAsync(
  dir: string,
  pred: (name: string, full: string) => boolean,
  depth: number,
  since: number,
  cache?: Map<string, DirListing>,
  seen?: Set<string>,
): Promise<Array<{ path: string; mtime: number }>> {
  const limit = createLimiter(WALK_CONCURRENCY);
  const pending = new Map<string, Promise<DirEnt[] | null>>();
  const list = (d: string): Promise<DirEnt[] | null> => {
    let p = pending.get(d);
    if (!p) {
      p = limit(() => listDir(d, cache, seen));
      pending.set(d, p);
    }
    return p;
  };
  const files: string[] = [];
  let visited = 0;
  const go = async (d: string, dep: number): Promise<void> => {
    if (dep < 0 || visited > MAX_WALK_ENTRIES) return;
    const ents = await list(d);
    pending.delete(d);
    if (!ents) return;
    // 预取下一层（只在还会进入时）；消费顺序不变
    if (dep >= 1) for (const e of ents) if (e.dir) void list(path.join(d, e.name));
    for (const e of ents) {
      visited++;
      const full = path.join(d, e.name);
      if (e.dir) await go(full, dep - 1);
      else if (e.file && pred(e.name, full)) files.push(full);
    }
  };
  await go(dir, depth);
  // 超过上限后没进入的预取目录：等它们收尾，免得遍历返回后还有悬空的读盘
  await Promise.all(pending.values());
  const stats = await Promise.all(files.map((f) => limit(() => statOf(f))));
  const out: Array<{ path: string; mtime: number }> = [];
  files.forEach((f, i) => {
    const st = stats[i];
    if (st && st.mtimeMs >= since) out.push({ path: f, mtime: st.mtimeMs });
  });
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES_PER_KIND);
}

async function listDir(
  d: string,
  cache?: Map<string, DirListing>,
  seen?: Set<string>,
): Promise<DirEnt[] | null> {
  if (!cache) return readDirEnts(d);
  const st = await statOf(d);
  if (!st?.isDirectory()) {
    cache.delete(d);
    return null;
  }
  seen?.add(d);
  const hit = cache.get(d);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino) return hit.ents;
  const listedAt = Date.now();
  const ents = await readDirEnts(d);
  if (ents && st.mtimeMs < listedAt - DIR_CACHE_RACY_MS)
    cache.set(d, { mtimeMs: st.mtimeMs, ino: st.ino, ents });
  else cache.delete(d);
  return ents;
}

async function readDirEnts(d: string): Promise<DirEnt[] | null> {
  try {
    const ents = await fs.promises.readdir(d, { withFileTypes: true });
    return ents.map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }));
  } catch {
    return null;
  }
}

/** chats 目录下的会话文件：直接子级要 session- 前缀，更深一层（subagent）任意 .json / .jsonl */
export function isGeminiChatFile(name: string, full: string): boolean {
  if (!/\.jsonl?$/.test(name)) return false;
  const parts = full.split(path.sep);
  const i = parts.lastIndexOf('chats');
  if (i < 0 || i >= parts.length - 1) return false;
  return parts.length - 1 === i + 1 ? /^session-/.test(name) : true;
}

/** Gemini 会话文件 → 项目目录名（tmp/<项目>/chats/…）；是 64 位十六进制哈希就不当项目名 */
function geminiProject(file: string): string | undefined {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf('chats');
  const proj = i > 0 ? parts[i - 1] : undefined;
  return proj && !/^[0-9a-f]{32,}$/i.test(proj) ? proj : undefined;
}

/**
 * Kimi 会话 id（取自路径）：Kimi Code `sessions/<会话>/agents/<agent>/wire.jsonl` → <会话>；
 * 旧 kimi-cli `sessions/<工作区哈希>/<会话>/wire.jsonl` → <会话>。
 */
export function kimiSessionId(file: string): string | undefined {
  const parts = file.split(path.sep);
  const a = parts.lastIndexOf('agents');
  const id = a > 0 && parts.length - a === 3 ? parts[a - 1] : parts[parts.length - 2];
  return id ? id.replace(/^(?:ses_|session_)(?=[0-9a-f-]{36}$)/i, '') : undefined;
}

/** 游标校验点：已消费区域末尾这么多字节做指纹 */
const FP_BYTES = 256;

function sha1(b: Buffer): string {
  return crypto.createHash('sha1').update(b).digest('hex');
}

/** 文件身份：Windows 上 ino 可能是 0 / 不可靠，取不到就不比较 */
function identityOf(st: fs.Stats): { dev?: number; ino?: number } {
  return st.ino ? { dev: st.dev, ino: st.ino } : {};
}

/** 游标记录的文件身份和现在不一致 = 同路径换成了另一个文件 */
function identityChanged(cur: FileCursor, st: fs.Stats): boolean {
  return cur.ino !== undefined && !!st.ino && (cur.ino !== st.ino || cur.dev !== st.dev);
}

async function fingerprintAt(
  fh: fs.promises.FileHandle,
  offset: number,
): Promise<{ fp: string; fpLen: number } | null> {
  const len = Math.min(FP_BYTES, offset);
  if (len <= 0) return null;
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, offset - len);
  return bytesRead === len ? { fp: sha1(buf), fpLen: len } : null;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

export class UsageLogScanner {
  private readonly home: string;
  private readonly dshHome: string;
  private readonly grokHome: string;
  private readonly env: NodeJS.ProcessEnv;
  private running = false;
  /** 目录列表缓存（按目录 mtime 失效），跨轮复用 */
  private readonly dirCache = new Map<string, DirListing>();

  constructor(private readonly d: ScannerDeps) {
    this.home = d.home ?? os.homedir();
    this.env = d.env ?? process.env;
    this.dshHome =
      d.dshHome ??
      (this.env.DSH_HOME?.trim() ? path.resolve(this.env.DSH_HOME) : path.join(this.home, '.dsh'));
    this.grokHome = d.grokHome ?? grokHomeDir(this.home, this.env);
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  /** 本机检测到的、能读用量日志的工具 */
  detected(): UsageSource[] {
    const h = this.home;
    const out: UsageSource[] = [];
    if (fs.existsSync(this.claudeDir())) out.push('claude');
    if (fs.existsSync(this.codexDir())) out.push('codex');
    if (fs.existsSync(path.join(this.dshHome, 'sessions'))) out.push('dsh');
    if (fs.existsSync(path.join(this.grokHome, 'sessions'))) out.push('grok');
    if (fs.existsSync(geminiDir(h, this.env))) out.push('gemini');
    if (fs.existsSync(qwenDir(h, this.env))) out.push('qwen');
    if (fs.existsSync(this.opencodeDb())) out.push('opencode');
    if (fs.existsSync(this.copilotDb())) out.push('copilot');
    if (kimiDirs(h, this.env).some((d) => fs.existsSync(path.join(d, 'sessions'))))
      out.push('kimi');
    if (fs.existsSync(path.join(h, '.aider', 'analytics.jsonl'))) out.push('aider');
    return out;
  }

  private claudeDir(): string {
    return path.join(claudeConfigDir(this.home, this.env), 'projects');
  }

  private codexDir(): string {
    return path.join(codexHomeDir(this.home, this.env), 'sessions');
  }

  private opencodeDb(): string {
    return path.join(opencodeDir(this.home, this.env), 'opencode.db');
  }

  private copilotDb(): string {
    return path.join(copilotDir(this.home, this.env), 'session-store.db');
  }

  /** 候选文件（各工具 mtime 倒序；只含回看窗口内修改过的） */
  async find(): Promise<Found[]> {
    const keep = RETENTION_MS[this.d.retention()];
    const since = this.now() - Math.min(keep, MAX_LOOKBACK_MS);
    const out: Found[] = [];
    // 本轮遍历到的目录：没再遇到的（被删除 / 超出范围）从列表缓存里清掉
    const seen = new Set<string>();
    const walk = (
      dir: string,
      pred: (name: string, full: string) => boolean,
      depth: number,
      at: number,
    ) => walkAsync(dir, pred, depth, at, this.dirCache, seen);
    const add = (
      source: UsageSource,
      mode: Found['mode'],
      list: Array<{ path: string; mtime: number }>,
    ) => {
      for (const f of list) out.push({ source, mode, ...f });
    };
    add('claude', 'jsonl', await walk(this.claudeDir(), (n) => n.endsWith('.jsonl'), 4, since));
    add('codex', 'jsonl', await walk(this.codexDir(), (n) => n.endsWith('.jsonl'), 4, since));
    // dsh：明文 jsonl 可增量；.zstd 要整份解压
    const dshFiles = await walk(
      path.join(this.dshHome, 'sessions'),
      // V0 是 session.jsonl，之后是 session.v<N>.jsonl（可能 zstd 压缩）
      (n) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(n),
      3,
      since,
    );
    add(
      'dsh',
      'jsonl',
      dshFiles.filter((f) => !f.path.endsWith('.zstd')),
    );
    add(
      'dsh',
      'whole',
      dshFiles.filter((f) => f.path.endsWith('.zstd')),
    );
    // Grok Build：sessions/<cwd>/<uuid>/updates.jsonl（turn_completed + usage）
    add(
      'grok',
      'jsonl',
      await walk(path.join(this.grokHome, 'sessions'), (n) => n === 'updates.jsonl', 4, since),
    );
    // Gemini：chats/session-*.json(l)；subagent 在 chats/<父id>/<子id>.jsonl（要递归）
    add(
      'gemini',
      'whole',
      await walk(
        path.join(geminiDir(this.home, this.env), 'tmp'),
        (n, full) => isGeminiChatFile(n, full),
        5,
        since,
      ),
    );
    // Qwen Code：tmp/<project_id>/chats/<sessionId>.jsonl
    add(
      'qwen',
      'jsonl',
      await walk(
        path.join(qwenDir(this.home, this.env), 'tmp'),
        (n, full) => n.endsWith('.jsonl') && full.includes(`${path.sep}chats${path.sep}`),
        4,
        since,
      ),
    );
    // Kimi：旧 kimi-cli 与 Kimi Code 的 sessions/**/wire.jsonl
    for (const root of kimiDirs(this.home, this.env))
      add(
        'kimi',
        'jsonl',
        await walk(path.join(root, 'sessions'), (n) => n === 'wire.jsonl', 6, since),
      );
    // SQLite：OpenCode / Copilot CLI（读之前先看库是否变过）
    for (const [source, file] of [
      ['opencode', this.opencodeDb()],
      ['copilot', this.copilotDb()],
    ] as const) {
      const dbSt = await statOf(file);
      if (dbSt) add(source, 'db', [{ path: file, mtime: dbSt.mtimeMs }]);
    }
    const aider = path.join(this.home, '.aider', 'analytics.jsonl');
    const st = await statOf(aider);
    if (st && st.mtimeMs >= since) add('aider', 'jsonl', [{ path: aider, mtime: st.mtimeMs }]);
    for (const d of this.dirCache.keys()) if (!seen.has(d)) this.dirCache.delete(d);
    return out;
  }

  /** 扫描一轮；返回新增 / 更新的记录数。重入时直接返回 0。 */
  async scan(): Promise<{ added: number; files: number }> {
    if (this.running) return { added: 0, files: 0 };
    this.running = true;
    let added = 0;
    let files = 0;
    try {
      // 游标与路由去重都依赖完整账本：大账本后台载入完成前先等
      await this.d.ledger.whenReady();
      for (const f of await this.find()) {
        if (this.d.routeBusy?.(f.source)) continue;
        try {
          const n =
            f.mode === 'jsonl'
              ? await this.readJsonl(f)
              : f.mode === 'db'
                ? await this.readDb(f)
                : await this.readWhole(f);
          if (n >= 0) files++;
          added += Math.max(0, n);
        } catch (e) {
          this.d.logger?.warn('usage scan file failed', {
            file: path.basename(f.path),
            e: String(e),
          });
        }
        await tick();
      }
    } finally {
      this.running = false;
    }
    return { added, files };
  }

  private ingest(recs: UsageRecord[]): number {
    const { ledger } = this.d;
    let n = 0;
    for (const r of recs) {
      if (!r.ts || r.ts < (this.d.clearedAt?.() ?? 0)) continue;
      if (r.source === 'claude' || r.source === 'codex') {
        // 同键的路由记录（Claude 原生 msg_… 路由与日志共用键）= 同一次请求；否则按身份 + 一对一匹配
        const same = ledger.get(r.key);
        const cover =
          same?.via === 'route'
            ? same
            : same
              ? null
              : ledger.routeCovering(r.source, r.ts, {
                  key: r.key,
                  session: r.session,
                  prompt: r.input + r.cacheRead + r.cacheWrite,
                  output: r.output,
                });
        if (cover) {
          // 费用以路由记录为准；日志只补上它不知道的会话 / 项目（供「按会话统计」归属），
          // 以及路由嗅探没拿到的计价分档（1h 缓存写 / 快速模式），让两条采集路径的费用口径一致。
          // 同时认领：这条路由记录不能再并入别的日志记录（一对一，重扫 / 重启后结果稳定）
          if (
            ledger.attribute(cover.key, {
              session: r.session,
              project: r.project,
              cacheWrite1h: r.cacheWrite1h,
              fast: r.fast,
              ...(cover.key !== r.key ? { logKey: r.key } : {}),
            })
          )
            n++;
          continue;
        }
      }
      if (ledger.upsert(r)) {
        n++;
        this.d.onNew?.(r);
      }
    }
    return n;
  }

  private parseChunk(source: UsageSource, text: string, state: ParseState): UsageRecord[] {
    switch (source) {
      case 'claude':
        return parseClaudeChunk(text);
      case 'codex': {
        const q = parseCodexRateLimits(text);
        if (q) this.d.onQuota?.(q);
        return parseCodexChunk(text, state);
      }
      case 'dsh':
        return parseDshChunk(text, state);
      case 'grok':
        return parseGrokChunk(text, state);
      case 'qwen':
        return parseQwenChunk(text);
      case 'kimi':
        return parseKimiChunk(text, state);
      case 'aider':
        return parseAiderChunk(text);
      default:
        return [];
    }
  }

  /** 增量读 jsonl；返回新增条数，-1 = 没有变化（跳过） */
  private async readJsonl(f: Found): Promise<number> {
    const { ledger } = this.d;
    const st = await statOf(f.path);
    if (!st) return -1;
    let cur = ledger.cursor(f.path);
    if (cur && st.size < cur.offset) cur = undefined; // 被截断 / 替换：从头读
    if (cur && identityChanged(cur, st)) cur = undefined; // 同路径换了文件（rename 替换 / 恢复备份）
    if (cur && cur.offset > 0 && (cur.size !== st.size || cur.mtimeMs !== st.mtimeMs)) {
      // 文件变过：只靠长度判断不了是追加还是重写。核对已消费区域末尾的指纹，对不上就从头读；
      // 没有指纹的旧游标无法核实，安全起见重读一次（账本按稳定键去重，不会重复记账）。
      cur = (await this.cursorStillValid(f.path, cur)) ? cur : undefined;
    }
    // 解析口径变了：丢掉旧偏移，把已经记成 unknown 的 Grok 轮次重读出来
    if (f.source === 'grok' && cur?.state?.rev !== GROK_LOG_REV) cur = undefined;
    if (cur && cur.offset >= st.size) {
      if (cur.size !== st.size || cur.mtimeMs !== st.mtimeMs || (!cur.fp && cur.offset > 0)) {
        // 旧游标补上身份 / 指纹（文件没变过才会走到这里：变过的旧游标已在上面丢弃）
        const fh = await fs.promises.open(f.path, 'r');
        try {
          const id = await fingerprintAt(fh, cur.offset);
          ledger.setCursor(f.path, {
            ...cur,
            size: st.size,
            mtimeMs: st.mtimeMs,
            ...identityOf(st),
            ...(id ?? {}),
          });
        } finally {
          await fh.close();
        }
      }
      return -1;
    }
    const state: ParseState = { ...(cur?.state ?? {}) };
    if (f.source === 'kimi' && !state.sid) state.sid = kimiSessionId(f.path);
    if (f.source === 'grok') state.rev = GROK_LOG_REV;
    if (f.source === 'grok' && !state.sid) {
      // .../sessions/<cwd>/<uuid>/updates.jsonl
      state.sid = path.basename(path.dirname(f.path));
      try {
        state.cwd = decodeURIComponent(path.basename(path.dirname(path.dirname(f.path))));
      } catch {
        /* keep encoded */
      }
    }
    const startOffset = cur?.offset ?? 0;
    let offset = startOffset; // 已处理到的位置（只落在完整行末尾）
    let readPos = startOffset;
    let pending: Buffer = Buffer.alloc(0);
    let added = 0;
    let id: { fp: string; fpLen: number } | null;
    const fh = await fs.promises.open(f.path, 'r');
    try {
      let budget = MAX_READ_PER_PASS;
      // 预算用完后，只要还没读到过一个完整行就继续（避免一行特别长时永远卡住）
      while (readPos < st.size && (budget > 0 || offset === startOffset)) {
        // 每块 256 KB：解析一块是一个不可打断的任务，块小一些主进程（所有窗口的 IPC）就不会被卡太久
        const len = Math.min(READ_CHUNK, st.size - readPos);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, readPos);
        if (bytesRead <= 0) break;
        readPos += bytesRead;
        budget -= bytesRead;
        const data = Buffer.concat([pending, buf.subarray(0, bytesRead)]);
        const nl = data.lastIndexOf(0x0a);
        if (nl < 0) {
          pending = data;
          if (pending.length > MAX_WHOLE_FILE) {
            // 超长的单行（异常）：放弃这一行
            offset = readPos;
            pending = Buffer.alloc(0);
          }
          continue;
        }
        const complete = data.subarray(0, nl + 1);
        pending = data.subarray(nl + 1);
        offset += complete.length;
        added += this.ingest(this.parseChunk(f.source, complete.toString('utf8'), state));
        await tick();
      }
      id = await fingerprintAt(fh, offset);
    } finally {
      await fh.close();
    }
    ledger.setCursor(f.path, {
      offset,
      size: st.size,
      mtimeMs: st.mtimeMs,
      ...identityOf(st),
      ...(id ?? {}),
      state,
    });
    return added;
  }

  /** 已消费区域末尾的内容还和游标里的指纹一致吗（一致 = 只是追加，可以接着读） */
  private async cursorStillValid(file: string, cur: FileCursor): Promise<boolean> {
    if (!cur.fp || !cur.fpLen) return false;
    let fh: fs.promises.FileHandle | undefined;
    try {
      fh = await fs.promises.open(file, 'r');
      const now = await fingerprintAt(fh, cur.offset);
      return !!now && now.fpLen === cur.fpLen && now.fp === cur.fp;
    } catch {
      return false;
    } finally {
      await fh?.close();
    }
  }

  /** 整份解析（Gemini JSON / dsh zstd）；返回新增条数，-1 = 没有变化 */
  private async readWhole(f: Found): Promise<number> {
    const { ledger } = this.d;
    const st = await statOf(f.path);
    if (!st) return -1;
    const cur = ledger.cursor(f.path);
    if (cur && cur.size === st.size && cur.mtimeMs === st.mtimeMs) return -1;
    if (st.size > MAX_WHOLE_FILE) {
      ledger.setCursor(f.path, { offset: st.size, size: st.size, mtimeMs: st.mtimeMs });
      return -1;
    }
    let recs: UsageRecord[] = [];
    if (f.source === 'gemini') {
      const text = await fs.promises.readFile(f.path, 'utf8');
      recs = parseGeminiFile(
        text,
        geminiProject(f.path),
        path.basename(f.path).replace(/\.jsonl?$/, ''),
      );
    } else if (f.source === 'dsh') {
      const text = await zstdDecode(await fs.promises.readFile(f.path));
      recs = parseDshChunk(text, {});
    }
    const added = this.ingest(recs);
    ledger.setCursor(f.path, { offset: st.size, size: st.size, mtimeMs: st.mtimeMs });
    return added;
  }

  /**
   * 只读 SQLite（OpenCode：message 表；Copilot：assistant_usage_events）：库 / WAL 没变就跳过；
   * 游标记「已读到的 time_updated / 行 id」，每轮最多一批。返回新增条数，-1 = 没有变化。
   */
  private async readDb(f: Found): Promise<number> {
    const { ledger } = this.d;
    const sig = dbSignature(f.path);
    if (!sig) return -1;
    const cur = ledger.cursor(f.path);
    const prev = (cur?.state ?? {}) as { sig?: string; last?: number };
    if (prev.sig === sig) return -1;
    const keep = RETENTION_MS[this.d.retention()];
    const since = this.now() - Math.min(keep, MAX_LOOKBACK_MS);
    const recs: UsageRecord[] = [];
    let last = prev.last ?? 0;
    let full = false;
    if (f.source === 'opencode') {
      // time_updated >= 游标：同一毫秒的行会重读一次，账本按消息 id 去重；首次只回看保留期内
      const rows = readOpencodeRows(f.path, Math.max(0, last || since));
      full = rows.length >= DB_BATCH;
      for (const r of rows) {
        const rec = opencodeRowToRecord(r);
        if (rec && rec.ts >= since) recs.push(rec);
        last = Math.max(last, Number(r.updated) || 0);
      }
    } else if (f.source === 'copilot') {
      const rows = readCopilotRows(f.path, last);
      full = rows.length >= DB_BATCH;
      for (const r of rows) {
        const rec = copilotRowToRecord(r);
        if (rec && rec.ts >= since) recs.push(rec);
        last = Math.max(last, Number(r.id) || 0);
      }
    }
    const added = this.ingest(recs);
    const st = await statOf(f.path);
    // 一批读满时不记 sig，下一轮继续追
    ledger.setCursor(f.path, {
      offset: st?.size ?? 0,
      size: st?.size ?? 0,
      mtimeMs: st?.mtimeMs ?? 0,
      state: full ? { last } : { sig, last },
    });
    await tick();
    return added;
  }
}
