/**
 * 按 (供应商, Key) 的并发上限与每分钟请求数（docs/design/cli-plugin-architecture.md §6.11.3）。
 * 多个标签加上辅助请求会同时打到同一个 Key：超出时排队（带超时），排队期间调用方给客户端发心跳；
 * 等不到就把这个候选当作「被限流」，换下一个（与 429 的冷却同一套处理）。
 * 上限来自供应商规格 / 配置的 quirks（maxConcurrency、rpm），Key 自己设的优先；都没设 = 不限，零开销。
 */
import type { RuntimeKey, RuntimeProvider } from './config';
import { quirksOf } from './providers/index';

export interface Limits {
  maxConcurrency?: number;
  rpm?: number;
}

/** 排队最多等多久（之后换候选） */
export const LIMIT_QUEUE_MS = 30_000;
const MINUTE = 60_000;

export function limitsOf(p: RuntimeProvider, key: RuntimeKey): Limits {
  const q = quirksOf(p);
  const pos = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);
  const maxConcurrency = pos(key.maxConcurrency) ?? pos(q.maxConcurrency);
  const rpm = pos(key.rpm) ?? pos(q.rpm);
  return { ...(maxConcurrency ? { maxConcurrency } : {}), ...(rpm ? { rpm } : {}) };
}

interface Slot {
  active: number;
  /** 最近一分钟内开始的请求时间 */
  starts: number[];
  queue: Array<() => void>;
}

export type Release = () => void;

export class Limiter {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly now: () => number = Date.now) {}

  private slot(id: string): Slot {
    let s = this.slots.get(id);
    if (!s) this.slots.set(id, (s = { active: 0, starts: [], queue: [] }));
    return s;
  }

  /** 现在能不能开始；不能时返回最早能开始的等待时长（ms），只受并发限制时为 Infinity */
  private blockedFor(s: Slot, l: Limits): number {
    const t = this.now();
    while (s.starts.length && t - s.starts[0]! >= MINUTE) s.starts.shift();
    const rpmWait = l.rpm && s.starts.length >= l.rpm ? MINUTE - (t - s.starts[0]!) : 0;
    const busy = l.maxConcurrency !== undefined && s.active >= l.maxConcurrency;
    if (busy) return Infinity;
    return rpmWait;
  }

  /**
   * 取一个名额。没有限制时立即返回；排队超过 timeoutMs 返回 null（调用方换候选）。
   * onWaiting：开始排队时回调一次（调用方先发响应头与心跳）。
   */
  async acquire(
    id: string,
    l: Limits,
    o: { timeoutMs?: number; onWaiting?: () => void; signal?: AbortSignal } = {},
  ): Promise<Release | null> {
    if (!l.maxConcurrency && !l.rpm) return () => undefined;
    const s = this.slot(id);
    const deadline = this.now() + (o.timeoutMs ?? LIMIT_QUEUE_MS);
    let waited = false;
    for (;;) {
      const wait = this.blockedFor(s, l);
      if (wait === 0) break;
      if (o.signal?.aborted || this.now() >= deadline) return null;
      if (!waited) {
        waited = true;
        o.onWaiting?.();
      }
      // 等并发名额释放，或等到每分钟窗口滑过去（取较早者，最长到截止时间）
      const ms = Math.max(1, Math.min(wait, deadline - this.now()));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        (timer as { unref?: () => void }).unref?.();
        function done() {
          clearTimeout(timer);
          const i = s.queue.indexOf(done);
          if (i >= 0) s.queue.splice(i, 1);
          resolve();
        }
        s.queue.push(done);
      });
    }
    s.active++;
    s.starts.push(this.now());
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.active--;
      // 叫醒一个排队的（它会重新检查限制）
      s.queue.shift()?.();
    };
  }

  /** 当前在用的名额数（诊断 / 测试） */
  active(id: string): number {
    return this.slots.get(id)?.active ?? 0;
  }
}
