/**
 * 诊断日志：编程助手子进程的原始收发（stdin / stdout / stderr、启动参数与退出码）。
 * 只在诊断日志开着时记录（开发版必开，正式版在「设置 → 隐私与权限」里由用户打开），
 * 写到 userData/logs/cli-YYYY-MM-DD.jsonl，每行一条（带 tab = 标签 id，按标签分组排查，§8.3）；
 * 单日超过上限后停写并留一行说明。
 * 文本按常见密钥格式脱敏（Bearer、sk-…等）；令牌只在子进程环境变量里，环境变量不记录。
 * 文件与 app.log 在同一目录，随旧日志清理一起删除（7 天）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { redactText } from '@nomi-ai/gateway';

/** 单日文件上限 */
const MAX_DAY_BYTES = 200 * 1024 * 1024;
/** 单条记录最多保留的字符数 */
const MAX_CHUNK_CHARS = 64 * 1024;

interface TapTarget {
  pid?: number;
  stdin: { write: (...a: never[]) => boolean };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: 'close', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

let dir: string | null = null;
let enabled: () => boolean = () => false;
let day = '';
let written = 0;
let capped = false;

/** 主进程启动时配置一次：日志目录与「现在开没开」 */
export function configureCliTrace(o: { dir: string; enabled: () => boolean }): void {
  // 换目录前把旧目录的缓冲写完
  flushCliTraceSync();
  if (o.dir !== dir) day = '';
  dir = o.dir;
  enabled = o.enabled;
}

function file(now: Date): string | null {
  if (!dir) return null;
  const d = now.toISOString().slice(0, 10);
  if (d !== day) {
    day = d;
    capped = false;
    try {
      written = fs.statSync(path.join(dir, `cli-${d}.jsonl`)).size;
    } catch {
      written = 0;
    }
  }
  return path.join(dir, `cli-${d}.jsonl`);
}

/*
 * 写盘缓冲（同 LoggerService）：原来每个 stdout / stderr data 事件都同步 mkdirSync + appendFileSync，
 * 流式输出时一秒几十上百次，直接卡主进程。现在每条记录照旧当场脱敏、计入当日大小（上限判断不变），
 * 但只进内存队列；攒 FLUSH_MS 或攒够 FLUSH_BYTES 后用 fs.promises.appendFile 异步追加。
 * 同一时间只有一次写入在途，写完再写下一批，行的先后顺序与产生顺序一致；跨天时按各行自己的文件分批。
 * 目录每个 (目录, 文件) 只建一次；运行中目录被删（ENOENT）时重建再试一次。进程退出时同步写完剩下的。
 */
const FLUSH_MS = 200;
const FLUSH_BYTES = 256 * 1024;

interface Pending {
  file: string;
  line: string;
}

let pending: Pending[] = [];
let pendingBytes = 0;
let writing: Promise<void> | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let readyDir: string | null = null;
let exitHooked = false;

function ensureDir(f: string): void {
  const d = path.dirname(f);
  if (readyDir === d) return;
  fs.mkdirSync(d, { recursive: true });
  readyDir = d;
}

function scheduleFlush(ms: number): void {
  if (flushTimer) {
    if (ms > 0) return;
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushCliTrace();
  }, ms);
  flushTimer.unref?.();
}

/** 取出缓冲，按目标文件把相邻的行合成一批（保持顺序） */
function takeBatches(): Pending[] {
  const out: Pending[] = [];
  for (const p of pending) {
    const last = out[out.length - 1];
    if (last && last.file === p.file) last.line += p.line;
    else out.push({ ...p });
  }
  pending = [];
  pendingBytes = 0;
  return out;
}

async function appendBatch(b: Pending): Promise<void> {
  try {
    ensureDir(b.file);
    await fs.promises.appendFile(b.file, b.line, { mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    readyDir = null;
    ensureDir(b.file);
    await fs.promises.appendFile(b.file, b.line, { mode: 0o600 });
  }
}

/** 异步写出缓冲；返回的 Promise 在当前已入队的记录全部落盘（或写失败被丢弃）后完成 */
export function flushCliTrace(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (writing) {
    // 有写入在途：等它写完再接着写，保证顺序
    return writing.then(() => flushCliTrace());
  }
  if (!pending.length) return Promise.resolve();
  const batches = takeBatches();
  writing = (async () => {
    for (const b of batches) {
      try {
        await appendBatch(b);
      } catch {
        /* 诊断日志写不了不能影响编程助手 */
      }
    }
  })().finally(() => {
    writing = null;
    if (pending.length) scheduleFlush(0);
  });
  return writing;
}

/** 同步写出缓冲（进程退出 / 测试）。在途的异步写入不等，剩下的直接同步追加。 */
export function flushCliTraceSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const b of takeBatches()) {
    try {
      ensureDir(b.file);
      fs.appendFileSync(b.file, b.line, { mode: 0o600 });
    } catch {
      /* 诊断日志写不了不能影响编程助手 */
    }
  }
}

function write(rec: Record<string, unknown>): void {
  if (!enabled()) return;
  const now = new Date();
  const f = file(now);
  if (!f || capped) return;
  let line = `${JSON.stringify({ t: now.toISOString(), ...rec })}\n`;
  if (written + line.length > MAX_DAY_BYTES) {
    capped = true;
    line = `${JSON.stringify({ t: now.toISOString(), note: 'daily size limit reached, stop logging' })}\n`;
  }
  written += line.length;
  pending.push({ file: f, line });
  pendingBytes += line.length;
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', flushCliTraceSync);
  }
  scheduleFlush(pendingBytes >= FLUSH_BYTES ? 0 : FLUSH_MS);
}

function text(chunk: unknown): string {
  const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const cut = s.length > MAX_CHUNK_CHARS ? `${s.slice(0, MAX_CHUNK_CHARS)}…[truncated]` : s;
  return redactText(cut);
}

/**
 * 给一个刚 spawn 的 CLI 子进程挂上记录：没开诊断日志时什么都不做。
 * stdout / stderr 加的是额外的 data 监听，不影响原有的读取。
 */
export function traceCliChild(
  child: TapTarget,
  command: string,
  args: readonly string[],
  meta: { tabId?: string } = {},
): void {
  if (!enabled()) return;
  const cli = path.basename(command);
  const pid = child.pid;
  const tab = meta.tabId;
  const rec = (r: Record<string, unknown>) => write({ pid, cli, ...(tab ? { tab } : {}), ...r });
  rec({ ev: 'spawn', args: args.map((a) => redactText(a)) });
  const stdin = child.stdin as unknown as { write: (...a: unknown[]) => boolean };
  const orig = stdin.write.bind(stdin);
  stdin.write = (...a: unknown[]) => {
    rec({ ev: 'in', data: text(a[0]) });
    return orig(...a);
  };
  child.stdout.on('data', (c: unknown) => rec({ ev: 'out', data: text(c) }));
  child.stderr.on('data', (c: unknown) => rec({ ev: 'err', data: text(c) }));
  child.on('close', (code, signal) => rec({ ev: 'exit', code, signal }));
}
