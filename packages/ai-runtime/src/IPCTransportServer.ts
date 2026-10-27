/**
 * IPCTransportServer —— 把 AIClient 的方法反射到 `ai:<facade>:<method>` IPC 通道。
 *
 * 对齐 P6 计划 §P6-3：
 * - 输入：`AIClient` 与通道前缀（默认 `ai`）；
 * - 反射策略：以 [`IPC_METHODS`](file:///./channels.ts) 白名单驱动，一次性 `ipcMain.handle`
 *   注册；流式方法额外挂 `:chunk` 事件通道，通过 `reqId` 关联；
 * - 权限：可选 sender 白名单函数；
 * - 错误：抛错直接 throw，Electron 会序列化到 renderer 的 promise。
 *
 * 契约：`IPC_METHODS` 是 P6 阶段 IPC 表面的**快照锁**——测试里用它做通道数/名字回归。
 */

import type { AIClient } from '@nomi-ai/ai-sdk';

import { IPC_METHODS, channelName, chunkChannelName, type IpcMethodSpec } from './channels';
import type { IpcAdapter, IpcInvokeEvent } from './IpcAdapter';
import type { RuntimeLogger } from './logger';
import { ConsoleRuntimeLogger } from './logger';

export interface IPCTransportServerOptions {
  client: AIClient;
  adapter: IpcAdapter;
  logger?: RuntimeLogger;
  /** 允许的 sender id / url 判定；返回 false 则请求被拒绝并抛错 */
  isSenderAllowed?: (event: IpcInvokeEvent, spec: IpcMethodSpec) => boolean;
  /**
   * chat 门面请求真正发出前的主进程检查（如本地文件内容的外发授权）：可就地改写 options.messages；
   * 抛错则这次请求失败（流式请求以 done + error 结束）。流式请求带 signal：用户在检查等待中停止该轮时触发，
   * 用来撤掉还没答复的确认；无论检查结果如何，已停止的轮次都不会再创建上游请求。
   */
  prepareChat?: (
    options: Record<string, unknown>,
    method: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

interface FacadeLike {
  [method: string]: unknown;
}

/** 流式文本片段合批的间隔（约一帧） */
const STREAM_BATCH_MS = 16;

/** 只含 { type: 'delta' | 'reasoning', content: string } 的 chunk 可以与相邻的同类片段拼接 */
function mergeableText(value: unknown): { type: string; content: string } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if ((v.type !== 'delta' && v.type !== 'reasoning') || typeof v.content !== 'string') return null;
  if (Object.keys(v).length !== 2) return null;
  return { type: v.type, content: v.content };
}

export class IPCTransportServer {
  private readonly registered: string[] = [];
  /** 进行中的 chat 流：reqId → 本轮的取消控制器（覆盖外发检查到收尾的整个生命周期） */
  private readonly streamAborts = new Map<string, AbortController>();
  private started = false;
  private readonly logger: RuntimeLogger;

  constructor(private readonly opts: IPCTransportServerOptions) {
    this.logger = opts.logger ?? ConsoleRuntimeLogger;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    for (const spec of IPC_METHODS) {
      const ch = channelName(spec);
      this.opts.adapter.handle(ch, async (event, ...args) => {
        if (this.opts.isSenderAllowed && !this.opts.isSenderAllowed(event, spec)) {
          throw new Error(`[ai-runtime] sender ${event.senderId} is not allowed for ${ch}`);
        }
        return this.dispatch(event, spec, args);
      });
      this.registered.push(ch);
    }

    this.logger.info(`ipc transport ready · ${this.registered.length} channels`, {
      channels: this.registered.slice(0, 6),
      total: this.registered.length,
    });
  }

  stop(): void {
    if (!this.started) return;
    for (const ch of this.registered.splice(0)) {
      try {
        this.opts.adapter.removeHandler(ch);
      } catch (err) {
        this.logger.warn(`removeHandler(${ch}) threw`, err);
      }
    }
    this.started = false;
  }

  get channels(): readonly string[] {
    return this.registered;
  }

  private async dispatch(
    event: IpcInvokeEvent,
    spec: IpcMethodSpec,
    args: unknown[],
  ): Promise<unknown> {
    const facade = this.resolveFacade(spec.facade);
    const fn = facade[spec.method];
    if (typeof fn !== 'function') {
      throw new Error(`[ai-runtime] facade ${spec.facade}.${spec.method} is not a function`);
    }
    const bound = (fn as (...a: unknown[]) => unknown).bind(facade);

    if (spec.kind === 'stream') {
      return this.handleStream(event, spec, bound, args);
    }
    if (spec.facade === 'chat' && spec.method === 'abort' && typeof args[0] === 'string') {
      // 还在外发检查里的流没有上游请求可停：在这里标记取消，检查结束后不再创建（#160）
      this.streamAborts.get(args[0])?.abort();
    }
    await this.prepare(spec, args);
    return bound(...args);
  }

  private async prepare(spec: IpcMethodSpec, args: unknown[], signal?: AbortSignal): Promise<void> {
    const options = args[0];
    if (spec.facade !== 'chat' || !this.opts.prepareChat) return;
    if (!options || typeof options !== 'object') return;
    await this.opts.prepareChat(options as Record<string, unknown>, spec.method, signal);
  }

  /**
   * 流式方法：调用返回 `AsyncIterable`；每次 `next()` 得到的 value 通过
   * `:chunk` 通道 `sender.send()` 到发起窗口；完成后 return `{ ok: true, reqId }`。
   *
   * 通信协议（renderer 端约定）：
   *   invoke ai:chat:stream(opts)  → 立即拿到 { ok, reqId }
   *   订阅  ai:chat:stream:chunk   → { reqId, done: false, value }
   *   done  ai:chat:stream:chunk   → { reqId, done: true, error?: string }
   */
  private async handleStream(
    event: IpcInvokeEvent,
    spec: IpcMethodSpec,
    fn: (...a: unknown[]) => unknown,
    args: unknown[],
  ): Promise<{ ok: true; reqId: string }> {
    const chunkCh = chunkChannelName(spec);
    const firstArg = args[0] as { reqId?: string } | undefined;
    const reqId = firstArg?.reqId ?? cryptoRandomId();
    // chat 流的首参就是 options：reqId 写进它。其它流（tts.stream(text, opts)）客户端把 reqId
    // 单独放在最前面的 envelope 里：取出后用原始业务参数调用，位置参数不被改写。
    let callArgs = args;
    if (spec.facade === 'chat') {
      if (firstArg && typeof firstArg === 'object') {
        (firstArg as { reqId?: string }).reqId = reqId;
      }
    } else {
      callArgs = args.slice(1);
    }

    // 窗口已关闭 / 已销毁：向它 send 会抛 "Object has been destroyed"。停止推送并中止上游生成。
    const gone = (): boolean => {
      try {
        return event.isDestroyed?.() === true;
      } catch {
        return true;
      }
    };
    const safeSend = (payload: unknown): boolean => {
      if (gone()) return false;
      try {
        event.send(chunkCh, payload);
        return true;
      } catch {
        return false;
      }
    };
    // 逐 token 的文本片段按帧合批：上游每个 text-delta（常常只有一个 token）原来都单独 send 一次，
    // 每秒几十上百次结构化克隆 + 进程调度。相邻的同类文本片段先拼起来，一帧（STREAM_BATCH_MS）发一次；
    // 其它 chunk（工具调用、usage、done…）先把攒着的文本发出去再原样发送，顺序不变。
    let held: { type: string; content: string } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const sendHeld = (): boolean => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!held) return true;
      const value = held;
      held = null;
      return safeSend({ reqId, done: false, value });
    };
    const stop = (): void => {
      if (closed) return;
      closed = true;
      this.abortUpstream(spec, reqId);
    };
    // chat 流从收到起就登记取消所有权：外发检查等待确认时用户点停止，abort 也能命中这一轮
    const aborter = new AbortController();
    if (spec.facade === 'chat') this.streamAborts.set(reqId, aborter);
    const cancelled = (): boolean => aborter.signal.aborted;
    (async () => {
      try {
        // 先过主进程的外发检查，通过后才创建上游请求
        await this.prepare(spec, args, aborter.signal);
        if (gone()) return;
        // 检查期间已停止：不管确认最后是允许还是拒绝，都不再创建上游请求
        if (cancelled()) {
          safeSend({ reqId, done: true });
          return;
        }
        const iterable = fn(...callArgs) as AsyncIterable<unknown>;
        for await (const value of iterable) {
          if (closed) return;
          // 窗口没了：不等下一次发送失败，马上停掉上游
          if (gone()) return stop();
          const text = mergeableText(value);
          if (text) {
            if (held && held.type === text.type) held.content += text.content;
            else {
              if (!sendHeld()) return stop();
              held = { ...text };
            }
            if (!timer) {
              timer = setTimeout(() => {
                timer = null;
                if (!sendHeld()) stop();
              }, STREAM_BATCH_MS);
            }
            continue;
          }
          if (!sendHeld() || !safeSend({ reqId, done: false, value })) {
            stop();
            return; // for-await 提前退出，会调用迭代器的 return() 释放上游
          }
        }
        if (!sendHeld()) return stop();
        safeSend({ reqId, done: true });
      } catch (err) {
        sendHeld();
        if (cancelled()) {
          // 用户停止导致的失败（如撤掉确认后的「已取消」）：静默结束，不当作错误
          safeSend({ reqId, done: true });
          return;
        }
        this.logger.warn(`stream ${spec.facade}.${spec.method} threw`, err);
        safeSend({ reqId, done: true, error: (err as Error).message });
      } finally {
        // 只清理本轮登记的：同一 reqId 的新一轮已经登记时不能误删
        if (this.streamAborts.get(reqId) === aborter) this.streamAborts.delete(reqId);
      }
    })().catch((err) => this.logger.error('unhandled stream error', err));

    return { ok: true, reqId };
  }

  /** chat 类流式请求：窗口没了就让上游 provider 停止生成，别白白烧 token */
  private abortUpstream(spec: IpcMethodSpec, reqId: string): void {
    if (spec.facade !== 'chat') return;
    try {
      const chat = this.resolveFacade('chat');
      if (typeof chat.abort === 'function') (chat.abort as (id: string) => void)(reqId);
    } catch (err) {
      this.logger.warn('abort upstream failed', err);
    }
  }

  private resolveFacade(name: string): FacadeLike {
    const client = this.opts.client as unknown as Record<string, unknown>;
    // memory.userProfile / memory.facts / memory.summaries 走扁平化路径
    if (name === 'userProfile' || name === 'facts' || name === 'summaries') {
      const memory = client.memory as Record<string, unknown> | undefined;
      const sub = memory?.[name] as FacadeLike | undefined;
      if (!sub) throw new Error(`[ai-runtime] memory.${name} not found on AIClient`);
      return sub;
    }
    const facade = client[name] as FacadeLike | undefined;
    if (!facade) throw new Error(`[ai-runtime] facade '${name}' not found on AIClient`);
    return facade;
  }
}

function cryptoRandomId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
