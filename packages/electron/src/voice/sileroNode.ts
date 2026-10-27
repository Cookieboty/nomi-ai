/**
 * Silero VAD v5（主进程侧）：推理放在 worker_threads（sileroWorker.ts）里，主线程只转发帧、收概率。
 * 放在主进程（而不是渲染进程）：渲染进程的 CSP 无需放开 wasm-unsafe-eval；模型字节也不离开主进程。
 * 每个 SileroStream 一份独立状态（RNN 状态 + 64 样本上下文，保存在 worker 里，按流 id 区分）。
 *
 * - worker 崩溃 / 超时：当前请求全部失败（reject），下次请求时懒重建（状态从零开始）；
 * - 连续崩溃 maxCrashes 次仍没有一次成功（如 worker 脚本无法加载）：退回主进程内推理，不再反复拉起；
 * - 没有活跃流且没有请求时，idleMs 后结束 worker 释放 wasm 内存；
 * - 只在有请求进行中时 ref worker（纯 Node 脚本里 await 不会提前退出），空闲时 unref，不阻止应用退出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { createMainLogger } from '../utils/log';

import {
  createSileroEngine,
  type SileroEngine,
  type WorkerReply,
  type WorkerRequest,
} from './sileroCore';

const log = createMainLogger('silero');

/** worker_threads.Worker 中用到的部分（测试可注入假 worker） */
export interface WorkerLike {
  postMessage(m: WorkerRequest, transfer?: ArrayBuffer[]): void;
  on(ev: 'message', fn: (m: WorkerReply) => void): unknown;
  on(ev: 'error', fn: (e: Error) => void): unknown;
  on(ev: 'exit', fn: (code: number) => void): unknown;
  terminate(): unknown;
  ref?(): void;
  unref?(): void;
}

export interface SileroClientOptions {
  /** 拉起 worker；返回 null 或抛错表示不可用，直接走主进程内推理 */
  spawn: (() => WorkerLike | null) | null;
  /** 主进程内推理的回退引擎（懒创建） */
  local?: () => SileroEngine;
  /** 单次请求超时（含首次加载模型），超时视为 worker 卡死 */
  timeoutMs?: number;
  /** 无活跃流后多久结束 worker */
  idleMs?: number;
  /** 连续崩溃多少次后改用主进程内推理 */
  maxCrashes?: number;
}

interface Pending {
  resolve: (p: number) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SileroClient {
  private w: WorkerLike | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly live = new Set<string>();
  private crashes = 0;
  private local: SileroEngine | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private readonly timeoutMs: number;
  private readonly idleMs: number;
  private readonly maxCrashes: number;

  constructor(private readonly opts: SileroClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.idleMs = opts.idleMs ?? 60_000;
    this.maxCrashes = opts.maxCrashes ?? 3;
  }

  /** 是否已退回主进程内推理（测试 / 诊断用） */
  get inProcess(): boolean {
    return this.local !== null;
  }

  run(stream: string, model: string, frame: Float32Array): Promise<number> {
    this.live.add(stream);
    this.cancelIdle();
    if (this.local) return this.local.run(stream, model, frame);
    const w = this.worker();
    if (!w) return this.toLocal().run(stream, model, frame);
    const id = ++this.seq;
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.crash(w, new Error('Silero VAD 推理超时'));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      if (this.pending.size === 1) w.ref?.();
      // 帧缓冲直接转移给 worker（调用方传入的是 toFloat32 产生的独立副本）
      const owned = frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength;
      const f = owned ? frame : frame.slice();
      try {
        w.postMessage({ t: 'run', id, stream, model, frame: f }, [f.buffer as ArrayBuffer]);
      } catch (e) {
        this.settle(id, e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  close(stream: string): void {
    this.live.delete(stream);
    if (this.local) void this.local.close(stream);
    else this.w?.postMessage({ t: 'close', stream });
    this.maybeIdle();
  }

  /** 立即结束 worker（进行中的请求失败） */
  shutdown(): void {
    this.cancelIdle();
    const w = this.w;
    this.w = null;
    this.failAll(new Error('Silero VAD 已关闭'));
    if (w) void Promise.resolve(w.terminate()).catch(() => undefined);
  }

  private worker(): WorkerLike | null {
    if (this.w) return this.w;
    let w: WorkerLike | null = null;
    try {
      w = this.opts.spawn?.() ?? null;
    } catch (e) {
      log.warn('Silero worker 无法启动，改用主进程内推理', e);
      return null;
    }
    if (!w) return null;
    w.unref?.();
    w.on('message', (m: WorkerReply) => {
      if (this.w !== w) return;
      if (m.t === 'ok') {
        this.crashes = 0;
        this.settle(m.id, null, m.prob);
      } else this.settle(m.id, new Error(m.message));
    });
    w.on('error', (e: Error) => this.crash(w, e));
    w.on('exit', (code: number) => this.crash(w, new Error(`Silero worker 退出（${code}）`)));
    this.w = w;
    return w;
  }

  /** worker 出错 / 退出 / 卡死：失败所有请求，丢弃该 worker，下次请求懒重建 */
  private crash(w: WorkerLike, e: Error): void {
    if (this.w !== w) return;
    this.w = null;
    this.crashes += 1;
    log.warn('Silero worker 异常', e.message);
    this.failAll(e);
    void Promise.resolve(w.terminate()).catch(() => undefined);
    if (this.crashes >= this.maxCrashes) {
      log.warn(`Silero worker 连续 ${this.crashes} 次异常，改用主进程内推理`);
      this.toLocal();
    }
  }

  private toLocal(): SileroEngine {
    this.local ??= (this.opts.local ?? (() => createSileroEngine()))();
    return this.local;
  }

  private settle(id: number, err: Error | null, prob = 0): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (!this.pending.size) this.w?.unref?.();
    if (err) p.reject(err);
    else p.resolve(prob);
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
    if (!this.w || this.live.size || this.pending.size || this.idle) return;
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.live.size || this.pending.size) return;
      const w = this.w;
      this.w = null;
      if (w) void Promise.resolve(w.terminate()).catch(() => undefined);
    }, this.idleMs);
    this.idle.unref?.();
  }
}

/** 编译产物里与本文件同目录的 sileroWorker.js（dev：dist/voice；打包：app.asar/dist/voice） */
function spawnDefault(): WorkerLike | null {
  const file = path.join(__dirname, 'sileroWorker.js');
  if (!fs.existsSync(file)) return null; // ts-jest / ts-node 直接跑源码时没有 .js 产物
  return new Worker(file) as unknown as WorkerLike;
}

let shared: SileroClient | null = null;
function client(): SileroClient {
  shared ??= new SileroClient({ spawn: spawnDefault });
  return shared;
}

/** 测试用：替换 / 重置共享客户端 */
export function setSileroClient(c: SileroClient | null): void {
  shared?.shutdown();
  shared = c;
}

/** 应用退出时调用（可选：空闲的 worker 已 unref，不调用也不会阻止退出） */
export function shutdownSilero(): void {
  shared?.shutdown();
  shared = null;
}

let streamSeq = 0;

export class SileroStream {
  private readonly id = `s${++streamSeq}`;
  private closed = false;
  constructor(private readonly model: string) {}

  /** 同一会话不能并发 run：worker（或回退引擎）里所有流串行执行，结果按提交顺序返回 */
  prob(frame: Float32Array): Promise<number> {
    if (this.closed) return Promise.resolve(0);
    return client().run(this.id, this.model, frame);
  }

  /** 窗口关闭 / VAD 停止时释放 worker 里的状态 */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    client().close(this.id);
  }
}

/** 预热（下载完成 / 打开免按键时），失败返回错误信息 */
export async function warmup(model: string): Promise<string | null> {
  const s = new SileroStream(model);
  try {
    await s.prob(new Float32Array(512));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    s.dispose();
  }
}

/** IPC 收到的帧可能是 Float32Array、Buffer/Uint8Array（字节）、ArrayBuffer 或数字数组 */
export function toFloat32(x: unknown): Float32Array | null {
  // 用类型标签判断（跨 realm 时 instanceof 不可靠）
  const tag = Object.prototype.toString.call(x);
  if (tag === '[object Float32Array]') return new Float32Array(x as Float32Array);
  if (tag === '[object ArrayBuffer]') return new Float32Array((x as ArrayBuffer).slice(0));
  if (ArrayBuffer.isView(x)) {
    const b = new Uint8Array(x.buffer, x.byteOffset, x.byteLength).slice();
    return b.byteLength % 4 === 0 ? new Float32Array(b.buffer) : null;
  }
  if (Array.isArray(x)) return Float32Array.from(x as number[]);
  return null;
}
