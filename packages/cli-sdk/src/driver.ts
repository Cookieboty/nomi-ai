/**
 * 共享会话驱动的契约（docs/design/cli-plugin-architecture.md §5.4）：按协议而不是按 CLI 实现会话，
 * 编排层（标签、排队、持久化、前文携带、事件推给界面、闲置回收）只和这个接口打交道。
 *
 * 事件是会话级的：轮次内外的事件都从同一个流出来（ACP 轮次结束后的更新、命令列表、进程退出），
 * 每轮的 send() 只返回本轮结果。流有两种读法：同步监听（on，编排层用，保证与协议消息同序）
 * 与 AsyncIterable（events，插件 / 测试用）。
 */
import type { HarnessEvent, HarnessUsage, PermissionAnswer, SessionEvent } from './events';

/** 握手时协商出来的运行时能力（ACP initialize、app-server initialize 的应答） */
export interface StartResult {
  /** 会话 id（新建或续接）；app-server 新会话推迟到第一条消息时为 null */
  sessionId: string | null;
  /** 续接失败、改为新建了会话 */
  resumed?: boolean;
  version?: string;
  /** 会话当前的权限模式（ACP modes.currentModeId） */
  currentModeId?: string;
  capabilities: { loadSession?: boolean; images?: boolean; audio?: boolean; [k: string]: unknown };
}

/** 一轮的输入 */
export interface TurnInput {
  text: string;
  /** 协议原生的输入块（图片等）；给了就不用 text 拼 */
  blocks?: unknown[];
  signal?: AbortSignal;
  /** 协议参数（app-server 的沙箱 / 审批策略、模型、档位） */
  params?: Record<string, unknown>;
}

/** 一轮的结果 */
export interface TurnResult {
  /** 本轮 id（事件流里的 turnId） */
  turnId: string;
  /** 协议给出的结束原因（ACP stopReason、app-server turn.status、Claude result.subtype） */
  stopReason: string;
  /** 本轮的助手正文（只拼 text-delta / text） */
  text: string;
  sessionId: string | null;
  usage?: HarnessUsage;
  /** 协议给出的错误信息（stopReason 为失败类时） */
  error?: string;
  /** 本轮有工具调用被用户拒绝（有的 CLI 因此提前结束整轮，不应当成「已中止」） */
  denied?: boolean;
  /** 协议原始的结束数据（_meta 等），供插件定制 */
  raw?: unknown;
}

export interface SessionDriver {
  start(o: { cwd: string; resumeId?: string | null; signal?: AbortSignal }): Promise<StartResult>;
  /** 会话级事件流 */
  readonly events: AsyncIterable<SessionEvent>;
  /** 同步监听会话级事件；返回取消函数 */
  on(fn: (e: SessionEvent) => void): () => void;
  /** 发起一轮；增量从事件流出来，这里只返回本轮结果 */
  send(turn: TurnInput): Promise<TurnResult>;
  interrupt(): Promise<void>;
  setModel?(model: string | null, effort: string | null): Promise<'applied' | 'restart'>;
  setPermissionMode?(mode: string): Promise<'applied' | 'restart'>;
  respondPermission(id: string, answer: PermissionAnswer): boolean;
  readonly sessionId: string | null;
  readonly closed: boolean;
  close(): Promise<void>;
}

/** 会话级事件的分发：同步监听 + AsyncIterable（每次迭代从订阅那一刻起收事件） */
export class EventHub<E> {
  private readonly listeners = new Set<(e: E) => void>();
  private ended = false;

  on(fn: (e: E) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: E): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {
        /* 一个监听者出错不影响其他监听者与驱动本身 */
      }
    }
  }

  /** 会话结束：迭代器随之结束 */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const fn of [...this.listeners]) fn(END as E);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<E> {
    const queue: E[] = [];
    let wake: (() => void) | null = null;
    let done = this.ended;
    const off = this.on((e) => {
      if ((e as unknown) === END) done = true;
      else queue.push(e);
      wake?.();
    });
    return {
      next: async () => {
        for (;;) {
          if (queue.length) return { value: queue.shift() as E, done: false };
          if (done) {
            off();
            return { value: undefined, done: true };
          }
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
      return: async () => {
        off();
        return { value: undefined, done: true };
      },
    };
  }
}

const END = Symbol('end');

/** 从事件里拼本轮正文（text-delta 累加；整段 text 覆盖为最后一段之后追加） */
export function appendText(text: string, ev: HarnessEvent): string {
  if (ev.type === 'text-delta') return text + ev.text;
  if (ev.type === 'text') return text ? `${text}\n\n${ev.text}` : ev.text;
  return text;
}
