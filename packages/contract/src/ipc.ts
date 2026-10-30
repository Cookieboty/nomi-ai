/**
 * IPC 风格传输适配（docs/design/core-host-decoupling.md §5.2）。
 *
 * 本文件**不 import electron**：只描述最小的 IPC 形状，宿主（host-electron）把
 * `ipcMain` / preload 的桥接对象接进来即可。形状与现有实现对齐：
 * - 服务端 `IpcMainLike` ≈ `@nomi-ai/ai-runtime` 的 `IpcAdapter`（handle / removeHandler，事件带 senderId / send）；
 * - 客户端 `IpcBridgeLike` ≈ `@nomi-ai/ai-sdk-client` 的 `IPCBridge`（invoke / on）。
 *
 * 线上只有两个通道：
 * - `contract:request`（invoke，视图 → 内核）：载荷 `{ c, frame }`；
 * - `contract:frame`（send，内核 → 视图）：载荷 `{ c, frame }`。
 * `c` 是客户端实例 id：同一窗口里可以有多个客户端，刷新页面后的新客户端也不会收到旧客户端的帧。
 *
 * 会话生命周期：服务端看不到渲染进程里客户端的销毁，刷新 / 导航后旧客户端的会话会一直留着。
 * **宿主必须在窗口导航（`did-start-navigation` / `did-navigate`）与 webContents 销毁时调用
 * `transport.disconnect(senderId)`**；`maxSessionsPerSender` 只是兜底，防止忘记调用时无限增长。
 */

import { ContractError } from './errors';
import { createFrameClientTransport, randomId, type FrameClientTransport } from './frameClient';
import type { ClientFrame, ServerFrame } from './protocol';
import type { CallerContext, Router } from './router';
import { createServerSession, type ServerSession } from './server';
import type { ContractLogger, ServerTransport } from './transport';

export const IPC_REQUEST_CHANNEL = 'contract:request';
export const IPC_FRAME_CHANNEL = 'contract:frame';

export interface IpcEnvelope<F> {
  c: string;
  frame: F;
}

// ---------------------------------------------------------------------------
// 视图侧
// ---------------------------------------------------------------------------

/** 渲染进程的桥接对象（preload 暴露的 `window.nomiTransport` 只需满足这个形状） */
export interface IpcBridgeLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, fn: (payload: unknown) => void): () => void;
}

export interface IpcClientOptions {
  requestChannel?: string;
  frameChannel?: string;
  /** 客户端实例 id（默认随机） */
  clientId?: string;
  logger?: ContractLogger;
}

export function createIpcClientTransport(
  bridge: IpcBridgeLike,
  options: IpcClientOptions = {},
): FrameClientTransport {
  const requestChannel = options.requestChannel ?? IPC_REQUEST_CHANNEL;
  const frameChannel = options.frameChannel ?? IPC_FRAME_CHANNEL;
  const c = options.clientId ?? randomId();
  return createFrameClientTransport(
    {
      send: (frame: ClientFrame) =>
        bridge.invoke(requestChannel, { c, frame } satisfies IpcEnvelope<ClientFrame>),
      onFrame: (fn) =>
        bridge.on(frameChannel, (payload) => {
          const env = payload as Partial<IpcEnvelope<unknown>> | null;
          if (env && typeof env === 'object' && env.c === c) fn(env.frame);
        }),
    },
    { idPrefix: 'r', logger: options.logger },
  );
}

// ---------------------------------------------------------------------------
// 内核侧
// ---------------------------------------------------------------------------

/** 一次 invoke 的发送方（与 ai-runtime `IpcInvokeEvent` 同形） */
export interface IpcInvokeEventLike {
  senderId: number;
  senderUrl?: string;
  send(channel: string, payload: unknown): void;
  isDestroyed?(): boolean;
}

/** 主进程 IPC 的最小形状（与 ai-runtime `IpcAdapter` 的 handle / removeHandler 同形） */
export interface IpcMainLike {
  handle(
    channel: string,
    handler: (event: IpcInvokeEventLike, ...args: unknown[]) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface IpcServerOptions {
  /**
   * 判定调用者（§8）：根据 senderId / URL 给出 surface 与 trusted；返回 null 表示拒绝这个发送方。
   * 每一帧都会重新判定，页面导航到别处后旧会话会被关闭。
   */
  resolveCaller(event: IpcInvokeEventLike): CallerContext | null | undefined;
  requestChannel?: string;
  frameChannel?: string;
  logger?: ContractLogger;
  /**
   * 单个发送方（senderId）同时保留的会话上限（默认 16）。超出时关闭最早建立的会话（它进行中的
   * 调用被取消、订阅被移除），并以 warn 记录。这只是兜底：宿主仍须在导航 / 销毁时调用
   * `disconnect(senderId)`。一个窗口里可能有多个客户端（各自一个会话），上限要留足余量。
   */
  maxSessionsPerSender?: number;
  /** 见 `ServerSessionOptions.strictSerialize`（默认：非 production 时开启） */
  strictSerialize?: boolean;
}

export const DEFAULT_MAX_SESSIONS_PER_SENDER = 16;

export interface IpcServerTransport extends ServerTransport {
  /**
   * 关闭某个窗口上的全部会话。宿主**必须**在窗口导航（含刷新）与 webContents 销毁时调用，
   * 否则旧页面的会话（订阅、进行中的流）会一直留到被 `maxSessionsPerSender` 挤掉。
   */
  disconnect(senderId: number): void;
  /** 某个窗口上全部会话里进行中的调用数（宿主据此判断窗口是否空闲、可以回收） */
  inflightFor(senderId: number): number;
  readonly sessionCount: number;
}

function sameCaller(a: CallerContext, b: CallerContext): boolean {
  return a.surface === b.surface && a.trusted === b.trusted;
}

export function createIpcServerTransport(
  ipc: IpcMainLike,
  options: IpcServerOptions,
): IpcServerTransport {
  const requestChannel = options.requestChannel ?? IPC_REQUEST_CHANNEL;
  const frameChannel = options.frameChannel ?? IPC_FRAME_CHANNEL;
  const sessions = new Map<string, { senderId: number; session: ServerSession }>();
  const maxPerSender = Math.max(
    1,
    Math.floor(options.maxSessionsPerSender ?? DEFAULT_MAX_SESSIONS_PER_SENDER),
  );
  let serving = false;

  /** 给 senderId 腾出一个位置：按建立顺序（Map 插入顺序）关闭最早的会话 */
  const evictFor = (senderId: number): void => {
    const own = [...sessions.values()].filter((e) => e.senderId === senderId);
    for (let i = 0; i <= own.length - maxPerSender; i++) {
      const victim = own[i];
      if (!victim) break;
      options.logger?.warn('[contract] too many IPC sessions for one sender; closing the oldest', {
        senderId,
        limit: maxPerSender,
      });
      victim.session.close(
        new ContractError('TRANSPORT', 'Session evicted: too many sessions for this sender'),
      );
    }
  };

  const closeAll = (): void => {
    for (const { session } of [...sessions.values()]) session.close();
    sessions.clear();
  };

  return {
    serve(router: Router) {
      if (serving) throw new Error('[contract] IPC server transport is already serving');
      serving = true;

      ipc.handle(requestChannel, (event, payload) => {
        const env = payload as Partial<IpcEnvelope<unknown>> | null;
        if (!env || typeof env !== 'object' || typeof env.c !== 'string' || !env.c) {
          options.logger?.warn('[contract] dropped malformed IPC envelope', {
            senderId: event.senderId,
          });
          return;
        }
        const c = env.c;
        const reply = (frame: ServerFrame): boolean => {
          try {
            if (event.isDestroyed?.()) return false;
          } catch {
            return false;
          }
          event.send(frameChannel, { c, frame } satisfies IpcEnvelope<ServerFrame>);
          return true;
        };

        const caller = options.resolveCaller(event);
        const key = `${event.senderId}\u0000${c}`;
        let entry = sessions.get(key);
        if (!caller) {
          entry?.session.close();
          const id = (env.frame as { id?: unknown } | null)?.id;
          if (typeof id === 'string') {
            const error = new ContractError('FORBIDDEN', 'Sender is not allowed').toJSON();
            reply({ t: 'err', id, error });
          }
          return;
        }
        if (entry && !sameCaller(entry.session.caller, caller)) {
          entry.session.close();
          entry = undefined;
        }
        if (!entry || entry.session.closed) {
          if (entry) sessions.delete(key);
          evictFor(event.senderId);
          const session = createServerSession(router, {
            caller: { ...caller, id: caller.id ?? String(event.senderId) },
            send: reply,
            logger: options.logger,
            strictSerialize: options.strictSerialize,
            onClose: () => {
              if (sessions.get(key)?.session === session) sessions.delete(key);
            },
          });
          entry = { senderId: event.senderId, session };
          sessions.set(key, entry);
        }
        entry.session.receive(env.frame);
        return undefined;
      });

      return () => {
        if (!serving) return;
        serving = false;
        ipc.removeHandler(requestChannel);
        closeAll();
      };
    },
    disconnect(senderId: number) {
      for (const { senderId: id, session } of [...sessions.values()]) {
        if (id === senderId) session.close();
      }
    },
    inflightFor(senderId: number) {
      let n = 0;
      for (const { senderId: id, session } of sessions.values()) {
        if (id === senderId && !session.closed) n += session.inflight;
      }
      return n;
    },
    get sessionCount() {
      return sessions.size;
    },
  };
}
