/**
 * 传输接口（docs/design/core-host-decoupling.md §5.1）。
 *
 * 视图侧只依赖 `ClientTransport`，内核侧只依赖 `ServerTransport`；
 * Electron IPC / WebSocket / in-process 都是它们的实现，可以整体替换。
 */

import type { Router } from './router';
import type { ContractStream } from './stream';

export interface CallOptions {
  signal?: AbortSignal;
}

/** 视图侧传输：语义是「过程 / 事件」，不是「通道」 */
export interface ClientTransport {
  /** query / mutation */
  call(name: string, input: unknown, opts?: CallOptions): Promise<unknown>;
  /** stream：返回 chunk 序列，`result` 为流结束时的结果 */
  stream(name: string, input: unknown, opts?: CallOptions): ContractStream<unknown, unknown>;
  /** 订阅事件；返回退订函数 */
  subscribe(event: string, fn: (data: unknown) => void): () => void;
  /** 关闭连接：进行中的调用以 TRANSPORT 失败 */
  close?(): void;
}

/** 内核侧传输：把 router 挂到某种连接上；返回停止函数 */
export interface ServerTransport {
  serve(router: Router): () => void;
}

/** 可选的诊断日志（本包不直接打印，由宿主注入 LoggerService 等） */
export interface ContractLogger {
  warn(message: string, data?: unknown): void;
  error?(message: string, data?: unknown): void;
}
