/**
 * Codex 会话索引的异步读取：把 `state_5.sqlite` 的整表 SELECT（node:sqlite 是同步 API，大库要几十毫秒）
 * 放到 worker_threads（codexThreadWorker.ts）里执行，不阻塞主进程事件循环（所有窗口的 IPC）。
 *
 * - worker 懒启动；Codex 运行时库一直在变，worker 在请求之间复用，空闲 idleMs 后结束；
 * - worker 出错 / 退出 / 超时：当前请求失败（reject），由调用方保留上一份索引；下次请求懒重建；
 * - worker 连续 maxCrashes 次起不来（error / exit，不含超时）：退回主进程内读取，不再反复拉起；
 * - worker 脚本不存在（ts-jest 直接跑源码）或无法启动：直接主进程内读取（与改动前行为一致）；
 * - 只在有请求进行中时 ref worker，空闲时 unref，不阻止应用退出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { createMainLogger } from '../utils/log';

import { readCodexThreads, type CodexThreadRow } from './codexThreadIndex';

const log = createMainLogger('codex-index');

/** 主线程 → worker */
export interface CodexIndexRequest {
  id: number;
  file: string;
}

/** worker → 主线程 */
export type CodexIndexReply =
  { id: number; ok: true; rows: CodexThreadRow[] } | { id: number; ok: false; message: string };

/** worker_threads.Worker 中用到的部分（测试可注入假 worker） */
export interface CodexIndexWorkerLike {
  postMessage(m: CodexIndexRequest): void;
  on(ev: 'message', fn: (m: CodexIndexReply) => void): unknown;
  on(ev: 'error', fn: (e: Error) => void): unknown;
  on(ev: 'exit', fn: (code: number) => void): unknown;
  terminate(): unknown;
  ref?(): void;
  unref?(): void;
}

export interface CodexThreadReaderOptions {
  /** 拉起 worker；返回 null 或抛错表示不可用，直接主进程内读取 */
  spawn: (() => CodexIndexWorkerLike | null) | null;
  /** 主进程内读取（回退路径，默认 readCodexThreads） */
  local?: (file: string) => CodexThreadRow[];
  /** 单次查询超时，超时视为 worker 卡死 */
  timeoutMs?: number;
  /** 最后一次请求结束后多久结束 worker */
  idleMs?: number;
  /** 连续崩溃多少次后改用主进程内读取 */
  maxCrashes?: number;
}

interface Pending {
  resolve: (rows: CodexThreadRow[]) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexThreadReader {
  private w: CodexIndexWorkerLike | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private crashes = 0;
  private inProc = false;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private readonly timeoutMs: number;
  private readonly idleMs: number;
  private readonly maxCrashes: number;

  constructor(private readonly opts: CodexThreadReaderOptions) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.idleMs = opts.idleMs ?? 60_000;
    this.maxCrashes = opts.maxCrashes ?? 3;
  }

  /** 是否已退回主进程内读取（测试 / 诊断用） */
  get inProcess(): boolean {
    return this.inProc;
  }

  /** 当前是否有活着的 worker（测试 / 诊断用） */
  get running(): boolean {
    return this.w !== null;
  }

  read(file: string): Promise<CodexThreadRow[]> {
    this.cancelIdle();
    const w = this.inProc ? null : this.worker();
    if (!w) {
      this.inProc = true;
      try {
        return Promise.resolve((this.opts.local ?? readCodexThreads)(file));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
    const id = ++this.seq;
    return new Promise<CodexThreadRow[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.crash(w, new Error('Codex index query timed out'), false);
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      if (this.pending.size === 1) w.ref?.();
      try {
        w.postMessage({ id, file });
      } catch (e) {
        this.settle(id, e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** 立即结束 worker（进行中的请求失败） */
  shutdown(): void {
    this.cancelIdle();
    const w = this.w;
    this.w = null;
    this.failAll(new Error('Codex index reader closed'));
    if (w) void Promise.resolve(w.terminate()).catch(() => undefined);
  }

  private worker(): CodexIndexWorkerLike | null {
    if (this.w) return this.w;
    let w: CodexIndexWorkerLike | null = null;
    try {
      w = this.opts.spawn?.() ?? null;
    } catch (e) {
      log.warn('Codex 索引 worker 无法启动，改用主进程内读取', e);
      return null;
    }
    if (!w) return null;
    w.unref?.();
    w.on('message', (m: CodexIndexReply) => {
      if (this.w !== w) return;
      this.crashes = 0;
      if (m.ok) this.settle(m.id, null, m.rows);
      else this.settle(m.id, new Error(m.message));
    });
    w.on('error', (e: Error) => this.crash(w, e, true));
    w.on('exit', (code: number) =>
      this.crash(w, new Error(`Codex index worker exited (${code})`), true),
    );
    this.w = w;
    return w;
  }

  /**
   * worker 出错 / 退出 / 卡死：失败所有请求，丢弃该 worker，下次请求懒重建。
   * 超时不计入回退次数：库本身慢时改到主进程只会更卡。
   */
  private crash(w: CodexIndexWorkerLike, e: Error, count: boolean): void {
    if (this.w !== w) return;
    this.w = null;
    this.cancelIdle();
    if (count) this.crashes += 1;
    log.warn('Codex 索引 worker 异常', e.message);
    this.failAll(e);
    void Promise.resolve(w.terminate()).catch(() => undefined);
    if (this.crashes >= this.maxCrashes) {
      log.warn(`Codex 索引 worker 连续 ${this.crashes} 次异常，改用主进程内读取`);
      this.inProc = true;
    }
  }

  private settle(id: number, err: Error | null, rows: CodexThreadRow[] = []): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (!this.pending.size) this.w?.unref?.();
    if (err) p.reject(err);
    else p.resolve(rows);
    this.maybeIdle();
  }

  private failAll(e: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(e);
    }
  }

  private cancelIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  private maybeIdle(): void {
    if (!this.w || this.pending.size || this.idle) return;
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.pending.size) return;
      const w = this.w;
      this.w = null;
      if (w) void Promise.resolve(w.terminate()).catch(() => undefined);
    }, this.idleMs);
    this.idle.unref?.();
  }
}

/** 编译产物里与本文件同目录的 codexThreadWorker.js（dev：dist/cli；打包：app.asar/dist/cli） */
function spawnDefault(): CodexIndexWorkerLike | null {
  const file = path.join(__dirname, 'codexThreadWorker.js');
  if (!fs.existsSync(file)) return null; // ts-jest / ts-node 直接跑源码时没有 .js 产物
  return new Worker(file) as unknown as CodexIndexWorkerLike;
}

let shared: CodexThreadReader | null = null;

/** 默认的共享读取器（各 SessionHistoryService 实例共用一个 worker） */
export function readCodexThreadsAsync(file: string): Promise<CodexThreadRow[]> {
  shared ??= new CodexThreadReader({ spawn: spawnDefault });
  return shared.read(file);
}

/** 测试用：替换 / 重置共享读取器 */
export function setCodexThreadReader(r: CodexThreadReader | null): void {
  shared?.shutdown();
  shared = r;
}
