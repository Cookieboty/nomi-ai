/**
 * WebSocket 传输的视图侧（docs/design/core-host-decoupling.md §5.2、§8）：视图在普通浏览器里运行时
 * 用它连开发态内核（`pnpm dev:web`）；服务端在 `@nomi-ai/host-node`（只监听 127.0.0.1）。
 *
 * 握手：浏览器的 WebSocket 不能带自定义头，身份放在子协议里——
 * `[WS_PROTOCOL, 'nomi-token.<token>', 'nomi-surface.<surface>']`。服务端校验 Origin、一次性 token 与界面，
 * 通过后选中 `WS_PROTOCOL`；不通过直接拒绝升级。帧按 `wire.ts` 的文本格式（JSON + base64 的 Uint8Array）。
 *
 * 断线重连：连上过之后连接断开，进行中的调用以 TRANSPORT 失败（服务端会话已经没了），然后按退避
 * （`reconnect.initialDelayMs` 起翻倍，封顶 `maxDelayMs`）用同一套握手重连；断开期间的新调用直接以
 * TRANSPORT 失败，事件监听者保留，重连成功后把它们订阅回去。第一次连接就被拒绝（token / Origin 不对、
 * 内核没起来）不重连：`ready` reject，传输关闭。安全性质不变：每次重连都带同样的 token 与界面、
 * 浏览器照样带 Origin，服务端照样只听 127.0.0.1、逐条校验。内核重启后 token 变了，重连会一直被拒，
 * 这时刷新页面拿新 token。
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
  /** 连上过之后断线时重连（默认开）；`false` 关掉，断开即关闭传输 */
  reconnect?: boolean | { initialDelayMs?: number; maxDelayMs?: number };
  /** 连接状态变化（视图可据此提示「正在重连」） */
  onStatus?: (status: WebSocketClientStatus) => void;
}

export type WebSocketClientStatus = 'open' | 'reconnecting' | 'closed';

export interface WebSocketClientTransport extends FrameClientTransport {
  /** 第一次连接建立（服务端接受握手）后 resolve；第一次就被拒绝或断开时 reject */
  readonly ready: Promise<void>;
  /** 当前状态：`connecting`（第一次连接中）/ `open` / `reconnecting` / `closed` */
  readonly status: WebSocketClientStatus | 'connecting';
}

const DEFAULT_RECONNECT = { initialDelayMs: 250, maxDelayMs: 10_000 };

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
  const protocols = [
    WS_PROTOCOL,
    `${WS_TOKEN_PREFIX}${options.token}`,
    `${WS_SURFACE_PREFIX}${surface}`,
  ];
  const factory = options.createSocket ?? defaultFactory;
  const backoff =
    options.reconnect === false
      ? null
      : {
          ...DEFAULT_RECONNECT,
          ...(typeof options.reconnect === 'object' ? options.reconnect : {}),
        };

  const queue: string[] = [];
  const listeners = new Set<(frame: unknown) => void>();
  let status: WebSocketClientTransport['status'] = 'connecting';
  let everOpened = false;
  let userClosed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // 没人 await ready 时不报未处理的拒绝
  ready.catch(() => undefined);

  const setStatus = (next: WebSocketClientStatus): void => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };

  let socket: WebSocketLike;

  const transport = createFrameClientTransport(
    {
      send(frame: ClientFrame) {
        const text = encodeWireFrame(frame);
        if (socket.readyState === OPEN) socket.send(text);
        else if (socket.readyState === CONNECTING) queue.push(text);
        else if (status === 'reconnecting') {
          throw new ContractError('TRANSPORT', 'WebSocket is reconnecting');
        } else throw new ContractError('TRANSPORT', 'WebSocket is closed');
      },
      onFrame(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    { idPrefix: 'w', logger: options.logger },
  );

  const scheduleReconnect = (): void => {
    if (!backoff || userClosed) return;
    const delay = Math.min(backoff.maxDelayMs, backoff.initialDelayMs * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!userClosed) connect();
    }, delay);
  };

  const connect = (): void => {
    let sock: WebSocketLike;
    try {
      sock = factory(options.url, protocols);
    } catch (err) {
      if (!everOpened) throw err;
      options.logger?.warn('[contract] WebSocket reconnect failed to start', err);
      scheduleReconnect();
      return;
    }
    socket = sock;
    let down = false;

    sock.addEventListener('open', () => {
      if (sock !== socket || userClosed) return;
      attempt = 0;
      if (!everOpened) {
        everOpened = true;
        resolveReady();
      } else {
        // 新会话：先把监听中的事件订阅回去，再发断线期间排队的帧
        transport.connectionRestored();
      }
      setStatus('open');
      for (const text of queue.splice(0)) sock.send(text);
    });
    sock.addEventListener('message', (ev) => {
      if (sock !== socket) return;
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
      if (down || sock !== socket) return;
      down = true;
      queue.length = 0;
      if (userClosed) return;
      if (!everOpened || !backoff) {
        if (!everOpened) {
          rejectReady(new ContractError('TRANSPORT', 'WebSocket connection was refused or closed'));
        }
        setStatus('closed');
        transport.close();
        return;
      }
      if (status === 'open')
        options.logger?.warn('[contract] WebSocket connection lost; reconnecting');
      setStatus('reconnecting');
      // 进行中的调用随旧会话一起失败；监听者保留，重连后订阅回去
      transport.connectionLost(new ContractError('TRANSPORT', 'WebSocket connection lost'));
      scheduleReconnect();
    };
    sock.addEventListener('close', onDown);
    sock.addEventListener('error', onDown);
  };

  connect();

  const close = transport.close;
  const out = Object.assign(transport, {
    ready,
    close(): void {
      if (userClosed) return;
      // 先发 unsub（连接还开着时），再断开
      close();
      userClosed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      setStatus('closed');
      try {
        socket.close(1000, 'client closed');
      } catch {
        // 已关闭
      }
    },
  });
  Object.defineProperty(out, 'status', { get: () => status, enumerable: true });
  return out as unknown as WebSocketClientTransport;
}
