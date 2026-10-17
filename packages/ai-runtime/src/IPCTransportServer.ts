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
}

interface FacadeLike {
  [method: string]: unknown;
}

export class IPCTransportServer {
  private readonly registered: string[] = [];
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
    return bound(...args);
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
    if (firstArg && typeof firstArg === 'object') {
      (firstArg as { reqId?: string }).reqId = reqId;
    }

    const iterable = fn(...args) as AsyncIterable<unknown>;
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
    (async () => {
      try {
        for await (const value of iterable) {
          if (!safeSend({ reqId, done: false, value })) {
            this.abortUpstream(spec, reqId);
            return; // for-await 提前退出，会调用迭代器的 return() 释放上游
          }
        }
        safeSend({ reqId, done: true });
      } catch (err) {
        this.logger.warn(`stream ${spec.facade}.${spec.method} threw`, err);
        safeSend({ reqId, done: true, error: (err as Error).message });
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
