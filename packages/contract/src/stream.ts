/**
 * 客户端流：可 `for await` 的 chunk 序列 + 结束时的结果 `result`。
 *
 * - 单消费者：只能迭代一次；
 * - 消费方提前 `break` / `return()` 视为取消：触发 `onCancel`（发送 abort 帧），`result` 以 ABORTED 失败；
 * - 失败时迭代器抛出错误，`result` 同样失败（`result` 已挂空 catch，不消费它不会产生未处理的 rejection）。
 */

import { abortedError } from './errors';

export interface ContractStream<T, R = void> extends AsyncIterable<T> {
  /** 流正常结束时的结果；出错或被取消时失败 */
  readonly result: Promise<R>;
}

type Waiter<T> = {
  resolve: (r: IteratorResult<T, undefined>) => void;
  reject: (err: unknown) => void;
};

export class PushStream<T, R = void> implements ContractStream<T, R> {
  readonly result: Promise<R>;
  private resolveResult!: (value: R) => void;
  private rejectResult!: (err: unknown) => void;
  private readonly queue: T[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private state: 'open' | 'ended' | 'failed' = 'open';
  private failure: unknown;
  private iterated = false;

  constructor(private readonly onCancel?: () => void) {
    this.result = new Promise<R>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    this.result.catch(() => {});
  }

  get closed(): boolean {
    return this.state !== 'open';
  }

  push(value: T): void {
    if (this.state !== 'open') return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.queue.push(value);
  }

  end(result: R): void {
    if (this.state !== 'open') return;
    this.state = 'ended';
    this.resolveResult(result);
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  fail(err: unknown): void {
    if (this.state !== 'open') return;
    this.state = 'failed';
    this.failure = err;
    this.rejectResult(err);
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    if (this.iterated) throw new TypeError('[contract] a stream can only be iterated once');
    this.iterated = true;
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift() as T, done: false });
        }
        if (this.state === 'ended') return Promise.resolve({ value: undefined, done: true });
        if (this.state === 'failed') return Promise.reject(this.failure);
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
      return: () => {
        this.queue.length = 0;
        if (this.state === 'open') {
          this.fail(abortedError('Stream cancelled by consumer'));
          this.onCancel?.();
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
