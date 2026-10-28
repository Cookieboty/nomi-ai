/**
 * in-process 传输（docs/design/core-host-decoupling.md §5.2）：单元测试与无界面宿主用，
 * 内核与视图逻辑在同一进程。
 *
 * 帧仍然走完整的线协议，并且默认（`serialize: 'strict'`）每一帧都做可序列化检查 + structuredClone：
 * 在这里能跑通的契约，换成 Electron IPC / WebSocket 也能跑通（§4.2）。帧异步投递（微任务），
 * 与真实传输一样不会同步重入。
 */

import { createClient, type Client, type ClientOptions } from '../client';
import type { AnyContract } from '../contract';
import { ContractError } from '../errors';
import { createFrameClientTransport, type FrameClientTransport } from '../frameClient';
import { findUnserializable, type ClientFrame, type ServerFrame } from '../protocol';
import {
  implement,
  type CallerContext,
  type Handlers,
  type ImplementOptions,
  type Router,
} from '../router';
import { createServerSession, type ServerSession } from '../server';
import type { ContractLogger, ServerTransport } from '../transport';

/**
 * - `strict`（默认）：只允许 JSON 值 + Uint8Array，再 structuredClone；
 * - `structured`：只做 structuredClone（与 Electron IPC 的能力相当）；
 * - `none`：原样传引用（只在明确需要时用）。
 */
export type SerializeMode = 'strict' | 'structured' | 'none';

export interface InProcessOptions {
  serialize?: SerializeMode;
  logger?: ContractLogger;
}

export const TEST_CALLER: CallerContext = Object.freeze({ surface: 'test', trusted: true });

export interface InProcessClient extends FrameClientTransport {
  /** 模拟连接断开（窗口关闭）：服务端会话关闭、进行中的调用被取消 */
  disconnect(): void;
  /** 服务端发给这个客户端的帧数（断言「没订阅的连接一帧都收不到」） */
  readonly framesReceived: number;
}

export interface InProcessServer extends ServerTransport {
  /** 以给定调用者身份建立一个客户端连接 */
  connect(caller?: CallerContext): InProcessClient;
  readonly sessionCount: number;
}

function cloner(mode: SerializeMode): <T>(value: T) => T {
  if (mode === 'none') return (v) => v;
  return (value) => {
    if (mode === 'strict') {
      const bad = findUnserializable(value);
      if (bad) throw new TypeError(`value is not wire-safe (${bad})`);
    }
    return structuredClone(value);
  };
}

export function createInProcessServer(options: InProcessOptions = {}): InProcessServer {
  const clone = cloner(options.serialize ?? 'strict');
  let router: Router | null = null;
  const sessions = new Set<ServerSession>();

  return {
    serve(r: Router) {
      if (router) throw new Error('[contract] in-process server is already serving');
      router = r;
      return () => {
        if (router !== r) return;
        router = null;
        for (const s of [...sessions]) s.close();
        sessions.clear();
      };
    },

    connect(caller: CallerContext = TEST_CALLER): InProcessClient {
      const listeners = new Set<(frame: unknown) => void>();
      let session: ServerSession | null = null;
      let disconnected = false;
      let framesReceived = 0;

      const deliverToClient = (frame: ServerFrame): boolean => {
        if (disconnected) return false;
        const copy = clone(frame); // 抛错 = 这一帧不可序列化，由会话改发 err 帧
        queueMicrotask(() => {
          if (disconnected) return;
          framesReceived += 1;
          for (const fn of [...listeners]) fn(copy);
        });
        return true;
      };

      const ensureSession = (): ServerSession | null => {
        if (session && !session.closed) return session;
        if (!router) return null;
        const s = createServerSession(router, {
          caller,
          send: deliverToClient,
          logger: options.logger,
          // 可序列化检查由 cloner 按 serialize 模式做（'structured' / 'none' 要能放行）
          strictSerialize: false,
          onClose: () => sessions.delete(s),
        });
        sessions.add(s);
        session = s;
        return s;
      };

      const transport = createFrameClientTransport(
        {
          send(frame: ClientFrame) {
            if (disconnected) throw new ContractError('TRANSPORT', 'Disconnected');
            const copy = clone(frame);
            queueMicrotask(() => {
              if (disconnected) return;
              const s = ensureSession();
              if (s) {
                s.receive(copy);
                return;
              }
              if (copy.t === 'req') {
                deliverToClient({
                  t: 'err',
                  id: copy.id,
                  error: { code: 'TRANSPORT', message: 'Server is not serving' },
                });
              }
            });
          },
          onFrame(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
        },
        { logger: options.logger },
      );

      const disconnect = (): void => {
        if (disconnected) return;
        disconnected = true;
        session?.close();
        transport.close();
      };

      return Object.defineProperties(Object.assign(transport, { disconnect }), {
        framesReceived: { get: () => framesReceived, enumerable: true },
      }) as InProcessClient;
    },

    get sessionCount() {
      return sessions.size;
    },
  };
}

/** 一步拿到一对：`server.serve(router)` 后用 `client` 建 api */
export function createInProcessTransport(
  options: InProcessOptions & { caller?: CallerContext } = {},
): { server: InProcessServer; client: InProcessClient } {
  const server = createInProcessServer(options);
  return { server, client: server.connect(options.caller) };
}

// ---------------------------------------------------------------------------
// 局部实现：只实现测试关心的过程
// ---------------------------------------------------------------------------

/** 契约里没有处理函数的过程：调用时以 NOT_FOUND 失败（与「旧内核没有这个过程」一致） */
export function withMissingHandlers<C extends AnyContract>(
  contract: C,
  handlers: Partial<Handlers<C>>,
): Handlers<C> {
  const table: Record<string, unknown> = { ...handlers };
  for (const name of Object.keys(contract.procedures)) {
    if (typeof table[name] === 'function') continue;
    const fail = (): never => {
      throw new ContractError('NOT_FOUND', `Procedure '${name}' is not implemented here`);
    };
    table[name] =
      contract.procedures[name]?.kind === 'stream'
        ? // eslint-disable-next-line require-yield -- 第一次 next() 就失败
          async function* () {
            fail();
          }
        : fail;
  }
  return table as Handlers<C>;
}

export interface TestClientOptions extends InProcessOptions {
  /** 调用者身份（默认 TEST_CALLER）；测 surfaces / dangerous 时改成 `{ surface: 'mascot', trusted: true }` 等 */
  caller?: CallerContext;
  implement?: ImplementOptions;
  /** 客户端一侧的校验（默认全开）；视图测试的假内核只给关心的字段时关掉 output / events */
  clientValidate?: ClientOptions['validate'];
}

export interface TestClient<C extends AnyContract> {
  api: Client<C>;
  router: Router<C>;
  /** 断开并停止服务 */
  close(): void;
}

/**
 * 视图 / 内核单元测试用：只给出关心的处理函数，得到走完整线协议（strict 序列化）的类型化 api。
 *
 *   const { api, router, close } = createTestClient(appContract, {
 *     'theme.get': () => ({ pref: 'ink', resolved: 'ink' }),
 *   });
 *   router.events.publish('theme.changed', …);   // 推事件给 api.on 的订阅者
 */
export function createTestClient<C extends AnyContract>(
  contract: C,
  handlers: Partial<Handlers<C>>,
  options: TestClientOptions = {},
): TestClient<C> {
  const router = implement(contract, withMissingHandlers(contract, handlers), options.implement);
  const server = createInProcessServer(options);
  const stop = server.serve(router as unknown as Router);
  const transport = server.connect(options.caller);
  const api = createClient(contract, transport, {
    handshake: 'off',
    ...(options.clientValidate ? { validate: options.clientValidate } : {}),
  });
  return {
    api,
    router,
    close() {
      transport.disconnect();
      stop();
    },
  };
}
