/**
 * 诊断日志：编程助手子进程的原始收发（stdin / stdout / stderr、启动参数与退出码）。
 * 只在诊断日志开着时记录（开发版必开，正式版在「设置 → 隐私与权限」里由用户打开），
 * 写到 userData/logs/cli-YYYY-MM-DD.jsonl，每行一条（带 tab = 标签 id，按标签分组排查，§8.3）；
 * 单日超过上限后停写并留一行说明。
 * 文本按常见密钥格式脱敏（Bearer、sk-…等）；令牌只在子进程环境变量里，环境变量不记录。
 * 文件与 app.log 在同一目录，随旧日志清理一起删除（7 天）。
 *
 * 每个内核实例（DiagnosticsService）持有自己的 CliTrace；spawnHarness 经内核作用域找到当前内核的记录器。
 */
import fs from 'node:fs';
import path from 'node:path';

import { redactText } from '@nomi-ai/gateway';

import type { ScopedCliTrace } from '../core/scope';

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

function text(chunk: unknown): string {
  const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const cut = s.length > MAX_CHUNK_CHARS ? `${s.slice(0, MAX_CHUNK_CHARS)}…[truncated]` : s;
  return redactText(cut);
}

export interface CliTraceOptions {
  /** 日志目录（userData/logs） */
  dir: string;
  /** 现在开没开（每条记录写入前都会问） */
  enabled: () => boolean;
}

export class CliTrace implements ScopedCliTrace {
  private readonly dir: string;
  private readonly enabled: () => boolean;
  private day = '';
  private written = 0;
  private capped = false;
  private pending: Pending[] = [];
  private pendingBytes = 0;
  private writing: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private readyDir: string | null = null;
  private exitHooked = false;
  /** 进程退出时同步写完缓冲 */
  readonly flushSync = (): void => {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const b of this.takeBatches()) {
      try {
        this.ensureDir(b.file);
        fs.appendFileSync(b.file, b.line, { mode: 0o600 });
      } catch {
        /* 诊断日志写不了不能影响编程助手 */
      }
    }
  };

  constructor(o: CliTraceOptions) {
    this.dir = o.dir;
    this.enabled = o.enabled;
  }

  private file(now: Date): string {
    const d = now.toISOString().slice(0, 10);
    const f = path.join(this.dir, `cli-${d}.jsonl`);
    if (d !== this.day) {
      this.day = d;
      this.capped = false;
      try {
        this.written = fs.statSync(f).size;
      } catch {
        this.written = 0;
      }
    }
    return f;
  }

  private ensureDir(f: string): void {
    const d = path.dirname(f);
    if (this.readyDir === d) return;
    fs.mkdirSync(d, { recursive: true });
    this.readyDir = d;
  }

  private scheduleFlush(ms: number): void {
    if (this.flushTimer) {
      if (ms > 0) return;
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, ms);
    this.flushTimer.unref?.();
  }

  /** 取出缓冲，按目标文件把相邻的行合成一批（保持顺序） */
  private takeBatches(): Pending[] {
    const out: Pending[] = [];
    for (const p of this.pending) {
      const last = out[out.length - 1];
      if (last && last.file === p.file) last.line += p.line;
      else out.push({ ...p });
    }
    this.pending = [];
    this.pendingBytes = 0;
    return out;
  }

  private async appendBatch(b: Pending): Promise<void> {
    try {
      this.ensureDir(b.file);
      await fs.promises.appendFile(b.file, b.line, { mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.readyDir = null;
      this.ensureDir(b.file);
      await fs.promises.appendFile(b.file, b.line, { mode: 0o600 });
    }
  }

  /** 异步写出缓冲；返回的 Promise 在当前已入队的记录全部落盘（或写失败被丢弃）后完成 */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.writing) {
      // 有写入在途：等它写完再接着写，保证顺序
      return this.writing.then(() => this.flush());
    }
    if (!this.pending.length) return Promise.resolve();
    const batches = this.takeBatches();
    this.writing = (async () => {
      for (const b of batches) {
        try {
          await this.appendBatch(b);
        } catch {
          /* 诊断日志写不了不能影响编程助手 */
        }
      }
    })().finally(() => {
      this.writing = null;
      if (this.pending.length) this.scheduleFlush(0);
    });
    return this.writing;
  }

  /** 停用：写完缓冲并摘掉退出钩子（内核停止时） */
  dispose(): void {
    this.flushSync();
    if (this.exitHooked) {
      process.removeListener('exit', this.flushSync);
      this.exitHooked = false;
    }
  }

  private write(rec: Record<string, unknown>): void {
    if (!this.enabled()) return;
    const now = new Date();
    const f = this.file(now);
    if (this.capped) return;
    let line = `${JSON.stringify({ t: now.toISOString(), ...rec })}\n`;
    if (this.written + line.length > MAX_DAY_BYTES) {
      this.capped = true;
      line = `${JSON.stringify({ t: now.toISOString(), note: 'daily size limit reached, stop logging' })}\n`;
    }
    this.written += line.length;
    this.pending.push({ file: f, line });
    this.pendingBytes += line.length;
    if (!this.exitHooked) {
      this.exitHooked = true;
      process.once('exit', this.flushSync);
    }
    this.scheduleFlush(this.pendingBytes >= FLUSH_BYTES ? 0 : FLUSH_MS);
  }

  /**
   * 给一个刚 spawn 的 CLI 子进程挂上记录：没开诊断日志时什么都不做。
   * stdout / stderr 加的是额外的 data 监听，不影响原有的读取。
   */
  tap(
    target: unknown,
    command: string,
    args: readonly string[],
    meta: { tabId?: string } = {},
  ): void {
    if (!this.enabled()) return;
    const child = target as TapTarget;
    const cli = path.basename(command);
    const pid = child.pid;
    const tab = meta.tabId;
    const rec = (r: Record<string, unknown>) =>
      this.write({ pid, cli, ...(tab ? { tab } : {}), ...r });
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
}
