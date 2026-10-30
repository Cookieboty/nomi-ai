/**
 * 契约的 WebSocket 传输（服务端，docs/design/core-host-decoupling.md §5.2、§8）：开发态让视图在普通浏览器里
 * 连内核（`pnpm dev:web`）。视图侧是 `@nomi-ai/contract` 的 `createWebSocketClientTransport`。
 *
 * 安全（开发态也按「本机上别的网页 / 进程会来试」设计）：
 * - 只监听回环地址（默认 127.0.0.1），远端地址不是回环的连接直接拒绝；
 * - 每次启动一个随机 token（`createDevToken()`），视图在子协议 `nomi-token.<token>` 里带上；比较用
 *   `timingSafeEqual`；日志里只出现 token 的前 4 位。token 是唯一挡住本机其他进程的东西：Origin / Host 头
 *   浏览器之外的进程可以随意伪造，所以 token **不能**放在任何本机进程都能拿到的地方——dev:web 的开发服务器
 *   只往页面注入地址，token 只在打印给开发者的地址片段（`#nomi-token=…`，不发给服务器）里，页面存进
 *   sessionStorage（`resolveDevTransport`，`@nomi-ai/contract/app`）；
 * - 下面的 Origin / Host 检查挡的是浏览器里的别的网页（它们改不了这两个头），不是本机进程；
 * - 校验 Origin：必须**完全等于** `allowedOrigins` 里的一项（开发服务器的地址），没有 Origin 的连接也拒绝；
 * - 校验 Host（防 DNS rebinding）：只接受 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`；
 * - 界面（`nomi-surface.<surface>`）必须在 `surfaces` 里；caller 记为 `{ surface, trusted: true }`；
 * - 普通 HTTP 请求一律 426，不回任何内容；单条消息上限 `maxPayload`，连接数上限 `maxConnections`；
 *   只收文本帧（二进制帧关闭连接）。
 *
 * 每个连接一个服务端会话（`createServerSession`，与 Electron IPC / in-process 共用帧处理），连接关闭时
 * 取消它进行中的调用、移除订阅。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import {
  createServerSession,
  decodeWireFrame,
  encodeWireFrame,
  WS_PROTOCOL,
  WS_SURFACE_PREFIX,
  WS_TOKEN_PATTERN,
  WS_TOKEN_PREFIX,
  type ContractLogger,
  type Router,
  type ServerSession,
  type Surface,
  type WebSocketFactory,
  type WebSocketLike,
} from '@nomi-ai/contract';
import { WebSocket, WebSocketServer } from 'ws';

export type WebSocketSurface = Exclude<Surface, 'test'>;

export interface WebSocketServerOptions {
  /** 本次启动的随机 token（`createDevToken()`） */
  token: string;
  /** 允许的 Origin（开发服务器地址，如 `http://127.0.0.1:6128`），完全匹配 */
  allowedOrigins: readonly string[];
  /** 监听地址，只能是回环地址；默认 127.0.0.1 */
  host?: '127.0.0.1' | '::1';
  /** 端口；默认 0（系统分配） */
  port?: number;
  /** 允许连接的界面，默认 chat / mascot / settings */
  surfaces?: readonly WebSocketSurface[];
  /** 单条消息上限（字节），默认 32 MiB */
  maxPayload?: number;
  /** 同时连接数上限，默认 16 */
  maxConnections?: number;
  /** 见 `ServerSessionOptions.strictSerialize` */
  strictSerialize?: boolean;
  logger?: ContractLogger & { info?(message: string, data?: unknown): void };
}

export interface WebSocketContractServer {
  /** `ws://127.0.0.1:<port>` */
  readonly url: string;
  readonly port: number;
  readonly connectionCount: number;
  /** 被拒绝的升级请求数（测试 / 诊断用） */
  readonly rejectedCount: number;
  /** 断开全部连接并停止监听 */
  close(): Promise<void>;
}

const DEFAULT_SURFACES: readonly WebSocketSurface[] = ['chat', 'mascot', 'settings'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 一次性 token：32 字节随机数的 hex（64 个字符，满足子协议的字符要求） */
export function createDevToken(): string {
  return randomBytes(32).toString('hex');
}

/** 日志里只露 token 的前 4 位 */
export function redactToken(token: string): string {
  return `${token.slice(0, 4)}…`;
}

function sameToken(expected: Buffer, got: string): boolean {
  const buf = Buffer.from(got, 'utf8');
  return buf.length === expected.length && timingSafeEqual(buf, expected);
}

function reject(socket: Duplex, status: 400 | 401 | 403 | 404 | 503): void {
  const text = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    503: 'Service Unavailable',
  }[status];
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

/** 把 router 挂到一个只监听回环地址的 WebSocket 服务上 */
export async function serveContractOverWebSocket(
  router: Router,
  options: WebSocketServerOptions,
): Promise<WebSocketContractServer> {
  if (!WS_TOKEN_PATTERN.test(options.token)) throw new Error('[host-node] invalid WebSocket token');
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host))
    throw new Error('[host-node] the WebSocket transport only binds loopback');
  const origins = new Set(options.allowedOrigins);
  if (origins.size === 0) throw new Error('[host-node] allowedOrigins must not be empty');
  const surfaces = new Set<string>(options.surfaces ?? DEFAULT_SURFACES);
  const maxConnections = options.maxConnections ?? 16;
  const expected = Buffer.from(options.token, 'utf8');
  const log = options.logger;

  const http = createServer((_req, res) => {
    res.writeHead(426, { Connection: 'close', 'Content-Length': '0' });
    res.end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayload ?? 32 * 1024 * 1024,
    // 握手已在 upgrade 里校验过：选中线协议
    handleProtocols: () => WS_PROTOCOL,
  });
  const sessions = new Map<WebSocket, ServerSession>();
  let rejected = 0;
  let seq = 0;
  let port = 0;

  const deny = (
    socket: Duplex,
    status: 400 | 401 | 403 | 404 | 503,
    reason: string,
    req: IncomingMessage,
  ) => {
    rejected += 1;
    log?.warn('[host-node] rejected WebSocket upgrade', {
      reason,
      origin: req.headers.origin ?? null,
      remote: req.socket.remoteAddress ?? null,
    });
    reject(socket, status);
  };

  http.on('upgrade', (req, socket, head) => {
    const remote = req.socket.remoteAddress ?? '';
    if (!LOOPBACK.has(remote)) return deny(socket, 403, 'remote address is not loopback', req);
    const hostHeader = req.headers.host ?? '';
    const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (!okHosts.includes(hostHeader)) return deny(socket, 403, 'unexpected Host header', req);
    if ((req.url ?? '/') !== '/') return deny(socket, 404, 'unexpected path', req);
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin)) return deny(socket, 403, 'origin is not allowed', req);

    const offered = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!offered.includes(WS_PROTOCOL)) return deny(socket, 400, 'missing protocol', req);
    const tokenEntry = offered.find((p) => p.startsWith(WS_TOKEN_PREFIX));
    if (!tokenEntry || !sameToken(expected, tokenEntry.slice(WS_TOKEN_PREFIX.length))) {
      return deny(socket, 401, 'bad token', req);
    }
    const surface = offered
      .find((p) => p.startsWith(WS_SURFACE_PREFIX))
      ?.slice(WS_SURFACE_PREFIX.length);
    if (!surface || !surfaces.has(surface)) return deny(socket, 403, 'surface is not allowed', req);
    if (sessions.size >= maxConnections) return deny(socket, 503, 'too many connections', req);

    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = `ws-${++seq}`;
      const session = createServerSession(router, {
        caller: { surface: surface as WebSocketSurface, trusted: true, id },
        send(frame) {
          if (ws.readyState !== ws.OPEN) return false;
          ws.send(encodeWireFrame(frame));
          return true;
        },
        logger: log,
        ...(options.strictSerialize === undefined
          ? {}
          : { strictSerialize: options.strictSerialize }),
        onClose: () => sessions.delete(ws),
      });
      sessions.set(ws, session);
      log?.info?.('[host-node] WebSocket client connected', { id, surface, origin });
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          ws.close(1003, 'text frames only');
          return;
        }
        let frame: unknown;
        try {
          frame = decodeWireFrame(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
        } catch {
          log?.warn('[host-node] dropped malformed WebSocket message', { id });
          return;
        }
        session.receive(frame);
      });
      ws.on('close', () => {
        session.close();
        sessions.delete(ws);
      });
      ws.on('error', () => ws.terminate());
    });
  });

  await new Promise<void>((resolve, rejectListen) => {
    http.once('error', rejectListen);
    http.listen(options.port ?? 0, host, () => {
      http.off('error', rejectListen);
      resolve();
    });
  });
  port = (http.address() as AddressInfo).port;
  const url = host === '::1' ? `ws://[::1]:${port}` : `ws://${host}:${port}`;

  let closing: Promise<void> | undefined;
  return {
    url,
    port,
    get connectionCount() {
      return sessions.size;
    },
    get rejectedCount() {
      return rejected;
    },
    close() {
      closing ??= (async () => {
        for (const [ws, session] of [...sessions]) {
          session.close();
          ws.terminate();
        }
        sessions.clear();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        const closed = new Promise<void>((resolve) => http.close(() => resolve()));
        http.closeAllConnections();
        await closed;
      })();
      return closing;
    },
  };
}

/**
 * Node 里的视图侧连接（测试、冒烟脚本）：用 `ws` 包建连接并带上 Origin（浏览器自动带，Node 的全局
 * WebSocket 不让设）。交给 `createWebSocketClientTransport({ createSocket })`。
 */
export function createNodeWebSocketFactory(opts: { origin: string }): WebSocketFactory {
  return (url, protocols) =>
    new WebSocket(url, protocols, { origin: opts.origin }) as unknown as WebSocketLike;
}
