/**
 * 提交点（docs/design/cli-plugin-architecture.md §6.11.2）：提交点 = 第一个内容事件，不是上游的 2xx 响应头。
 * 中转服务常常先回 200，第一个事件就是 error / response.failed：在提交之前看到错误，还能换候选重来。
 *
 * peekCommit 读上游流的开头，直到：
 * - 第一个内容事件（正文 / 推理 / 工具调用的增量）→ 提交；
 * - 结束标记（没有内容的正常结束）→ 提交（交给正常路径处理）；
 * - 错误事件 → 不提交，返回错误（缓存的元事件丢弃，调用方换下一个候选）；
 * - 缓存的元事件超过 maxEvents 个，或等了 maxMs → 提交（不再缓存）；
 * - 上游流读完 → 提交（截断由协议桥的结束检测报错）。
 * 提交时返回一个新的 Response：先吐出已读的字节，再接着读上游，调用方像没读过一样处理。
 */
import type { Wire } from './ir';
import { specOf, toSpecEvent } from './spec/index';
import { SseParser } from './stream/sse';

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

export const COMMIT_MAX_EVENTS = 8;
export const COMMIT_MAX_MS = 10_000;

export type PeekResult =
  | {
      kind: 'commit';
      res: Response;
      /**
       * 因为看到内容事件而提交时，看到它的时刻（epoch ms）。按期限 / 事件数 / 结束标记 / 读完兜底提交时
       * 没有：那时还没有内容，首内容时间要以之后真正看到的为准（#136）
       */
      contentAt?: number;
    }
  | {
      kind: 'error';
      message: string;
      /** 按错误内容推断的状态码（限流 429、过载 529，其余 502） */
      status: number;
      /** 推断出是限流 / 过载时给出（冷却该 Key，§11.1） */
      upstreamStatus?: number;
    };

export interface PeekOptions {
  maxEvents?: number;
  maxMs?: number;
  /** 等待超过这个时长还没提交：回调一次（调用方先发响应头与 SSE 注释保活） */
  waitingMs?: number;
  onWaiting?: () => void;
  now?: () => number;
}

function errorOf(data: Record<string, unknown> | null): { message: string; kind: string } {
  const pick = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const d = pick(data);
  const resp = pick(d.response);
  const e = pick(d.error ?? resp.error);
  const message =
    (typeof e.message === 'string' && e.message) ||
    (typeof d.message === 'string' && d.message) ||
    'upstream returned an error event';
  const kind = [e.type, e.code, e.status, d.code].filter((x) => typeof x === 'string').join(' ');
  return { message, kind: `${kind} ${message}` };
}

function statusOf(kind: string): { status: number; upstreamStatus?: number } {
  if (/rate[_ ]?limit|too many requests|quota|429|RESOURCE_EXHAUSTED/i.test(kind))
    return { status: 429, upstreamStatus: 429 };
  if (/overloaded|529|UNAVAILABLE/i.test(kind)) return { status: 529, upstreamStatus: 529 };
  return { status: 502 };
}

/** 读到的字节 + 上游剩下的部分 → 新的 Response（状态码、响应头与原响应相同） */
function replay(
  up: Response,
  head: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  inflight: Promise<ReadResult> | null = null,
): Response {
  let i = 0;
  let first = inflight;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (i < head.length) {
        ctrl.enqueue(head[i++]!);
        return;
      }
      try {
        const next = first ?? reader.read();
        first = null;
        const { done, value } = await next;
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      } catch (e) {
        ctrl.error(e);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: up.status, statusText: up.statusText, headers: up.headers });
}

export async function peekCommit(
  up: Response,
  wire: Wire,
  o: PeekOptions = {},
): Promise<PeekResult> {
  if (!up.body) return { kind: 'commit', res: up };
  const spec = specOf(wire);
  const maxEvents = o.maxEvents ?? COMMIT_MAX_EVENTS;
  const maxMs = o.maxMs ?? COMMIT_MAX_MS;
  const now = o.now ?? Date.now;
  const started = now();
  const reader = up.body.getReader();
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const head: Uint8Array[] = [];
  let events = 0;
  const waitTimer =
    o.onWaiting && o.waitingMs !== undefined
      ? setTimeout(() => o.onWaiting?.(), o.waitingMs)
      : null;
  const commit = (): PeekResult => ({ kind: 'commit', res: replay(up, head, reader) });
  // 超时：读到一半也提交，剩下的读取交给正常路径（不能丢掉这次 read 的结果）
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<'expired'>((resolve) => {
    deadline = setTimeout(() => resolve('expired'), Math.max(0, maxMs - (now() - started)));
  });
  let pending: Promise<ReadResult> | null = null;
  try {
    for (;;) {
      pending ??= reader.read();
      const r = await Promise.race([pending, expired]);
      // 还在等的那次 read：结果作为提交后的第一块
      if (r === 'expired') return { kind: 'commit', res: replay(up, head, reader, pending) };
      pending = null;
      if (r.done) return commit();
      head.push(r.value);
      for (const raw of parser.push(decoder.decode(r.value, { stream: true }))) {
        const ev = toSpecEvent(raw);
        if (spec.isError(ev)) {
          const e = errorOf(ev.data);
          await reader.cancel().catch(() => undefined);
          return { kind: 'error', message: e.message, ...statusOf(e.kind) };
        }
        if (spec.isContent(ev)) return { ...commit(), contentAt: now() } as PeekResult;
        if (spec.isTerminal(ev)) return commit();
        if (++events >= maxEvents) return commit();
      }
    }
  } finally {
    if (waitTimer) clearTimeout(waitTimer);
    if (deadline) clearTimeout(deadline);
  }
}
