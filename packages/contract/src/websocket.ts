/**
 * WebSocket 传输的视图侧（docs/design/core-host-decoupling.md §5.2、§8）：视图在普通浏览器里运行时
 * 用它连开发态内核（`pnpm dev:web`）；服务端在 `@nomi-ai/host-node`（只监听 127.0.0.1）。
 *
 * 握手：浏览器的 WebSocket 不能带自定义头，身份放在子协议里——
 * `[WS_PROTOCOL, 'nomi-token.<token>', 'nomi-surface.<surface>']`。服务端校验 Origin、一次性 token 与界面，
 * 通过后选中 `WS_PROTOCOL`；不通过直接拒绝升级。帧按 `wire.ts` 的文本格式（JSON + base64 的 Uint8Array）。
 *
 * 连接断开后不重连：进行中的调用以 TRANSPORT 失败，之后的调用也失败（开发态内核重启后刷新页面）。
 *
 * 不依赖 Node 内置模块；缺省用 `globalThis.WebSocket`（浏览器、Node 22+）。
 */

import type { Surface } from './contract';
import { ContractError } from './errors';
import { createFrameClientTransport, type FrameClientTransport } from './frameClient';
import type { ClientFrame } from './protocol';
import type { ContractLogger } from './transport';
import { decodeWireFrame, encodeWireFrame } from './wire';

/** 线协议子协议名（服务端选中它表示握手成功） */
export const WS_PROTOCOL = 'nomi.contract.v1';
/** 携带一次性 token 的子协议前缀 */
export const WS_TOKEN_PREFIX = 'nomi-token.';
/** 携带调用者界面的子协议前缀 */
export const WS_SURFACE_PREFIX = 'nomi-surface.';
/** token 只用子协议允许的字符（RFC 6455 token），长度 16–256 */
export const WS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

const OPEN = 1;
const CONNECTING = 0;

/** 视图侧用到的最小 WebSocket 形状（浏览器 WebSocket 与 `ws` 包的 WebSocket 都满足） */
export interface WebSocketLike {
  readonly readyState: number;
  readonly protocol?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error', fn: () => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

export interface WebSocketClientOptions {
  /** `ws://127.0.0.1:<port>` */
  url: string;
  /** 开发态内核本次启动生成的随机 token */
  token: string;
  /** 调用者界面（服务端据此填 caller.surface），默认 `chat` */
  surface?: Exclude<Surface, 'test'>;
  /** 建连接的方式，默认 `new globalThis.WebSocket(url, protocols)`（测试里可换成 `ws` 包） */
  createSocket?: WebSocketFactory;
  logger?: ContractLogger;
}

export interface WebSocketClientTransport extends FrameClientTransport {
  /** 连接建立（服务端接受握手）后 resolve；被拒绝或断开时 reject */
  readonly ready: Promise<void>;
}

function defaultFactory(url: string, protocols: string[]): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (u: string, p: string[]) => WebSocketLike })
    .WebSocket;
  if (!Ctor) throw new ContractError('TRANSPORT', 'WebSocket is not available here');
  return new Ctor(url, protocols);
}

function messageText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return null;
}

export function createWebSocketClientTransport(
  options: WebSocketClientOptions,
): WebSocketClientTransport {
  if (!WS_TOKEN_PATTERN.test(options.token)) {
    throw new ContractError('BAD_REQUEST', 'Invalid WebSocket token');
  }
  const surface = options.surface ?? 'chat';
  const socket = (options.createSocket ?? defaultFactory)(options.url, [
    WS_PROTOCOL,
    `${WS_TOKEN_PREFIX}${options.token}`,
    `${WS_SURFACE_PREFIX}${surface}`,
  ]);

  const queue: string[] = [];
  const listeners = new Set<(frame: unknown) => void>();
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // 没人 await ready 时不报未处理的拒绝
  ready.catch(() => undefined);

  const transport = createFrameClientTransport(
    {
      send(frame: ClientFrame) {
        const text = encodeWireFrame(frame);
        if (socket.readyState === OPEN) socket.send(text);
        else if (socket.readyState === CONNECTING) queue.push(text);
        else throw new ContractError('TRANSPORT', 'WebSocket is closed');
      },
      onFrame(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    { idPrefix: 'w', logger: options.logger },
  );

  socket.addEventListener('open', () => {
    settled = true;
    resolveReady();
    for (const text of queue.splice(0)) socket.send(text);
  });
  socket.addEventListener('message', (ev) => {
    const text = messageText(ev.data);
    if (text === null) {
      options.logger?.warn('[contract] dropped non-text WebSocket message');
      return;
    }
    let frame: unknown;
    try {
      frame = decodeWireFrame(text);
    } catch {
      options.logger?.warn('[contract] dropped malformed WebSocket message');
      return;
    }
    for (const fn of [...listeners]) fn(frame);
  });
  const onDown = (): void => {
    queue.length = 0;
    if (!settled) {
      settled = true;
      rejectReady(new ContractError('TRANSPORT', 'WebSocket connection was refused or closed'));
    }
    // 进行中的调用以 TRANSPORT 失败；不重连
    transport.close();
  };
  socket.addEventListener('close', onDown);
  socket.addEventListener('error', onDown);

  const close = transport.close;
  return Object.assign(transport, {
    ready,
    close(): void {
      close();
      try {
        socket.close(1000, 'client closed');
      } catch {
        // 已关闭
      }
    },
  });
}
