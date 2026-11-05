/**
 * 窗口共享的契约传输与应用客户端（docs/design/core-host-decoupling.md §5、§12 P1b）。
 *
 * 一个窗口只开一个契约会话：`ClientAIClient` 与视图的 `services/api.ts`（`createAppClient()`）
 * 都用 `getSharedTransport()`，帧经同一个客户端 id 收发；页面刷新后新页面重新建。
 *
 * 传输由视图的 `services/api.ts` 在建客户端之前装上（`installSharedTransport`，Go 宿主经回环 WebSocket，
 * 见 `installGoHostTransport`）。没装上之前（浏览器预览、测试）调用以 BRIDGE_MISSING 失败、订阅不生效，
 * 不在 import 时抛。
 */

import {
  createClient,
  PushStream,
  type Client,
  type ClientOptions,
  type ClientTransport,
} from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';

import { SDKError, SDKErrorCodes } from './errors';

/** 视图侧的应用契约客户端类型 */
export type AppClient = Client<AppContract>;

const missing = (): SDKError =>
  new SDKError(
    SDKErrorCodes.BRIDGE_MISSING,
    '[ai-sdk-client] 契约传输未就绪：页面不在 Nomi 窗口里（没有宿主给的 WebSocket 地址）',
  );

/** 还没装上传输时的占位：调用失败、订阅不生效 */
function unavailableTransport(): ClientTransport {
  return {
    call: () => Promise.reject(missing()),
    stream() {
      const failed = new PushStream<unknown, unknown>();
      failed.fail(missing());
      return failed;
    },
    subscribe: () => () => undefined,
  };
}

interface SharedEntry {
  inner: ClientTransport;
  outer: ClientTransport;
}

/**
 * 按窗口（全局对象）存：本包的入口各自打包（`index` 与 `react` 各有一份本模块），两份模块各建一份时，
 * AIProvider（react 入口）里的 ClientAIClient 与视图的 `services/api.ts`（主入口）会各开一个会话，
 * `installSharedTransport` 也只换到其中一份。放在 `globalThis` 上，所有副本共用一份。
 */
const SHARED_KEY = Symbol.for('nomi.ai-sdk-client.sharedTransport');
const store = globalThis as Record<symbol, SharedEntry | undefined>;

function sharedEntry(): SharedEntry {
  let entry = store[SHARED_KEY];
  if (!entry) {
    // outer 每次调用时才读 entry.inner：installSharedTransport 换掉内层后，已经建好的客户端也走新传输
    const e: SharedEntry = {
      inner: unavailableTransport(),
      outer: {
        call: (name, input, opts) => e.inner.call(name, input, opts),
        stream: (name, input, opts) => e.inner.stream(name, input, opts),
        subscribe: (event, fn) => e.inner.subscribe(event, fn),
      },
    };
    entry = e;
    store[SHARED_KEY] = entry;
  }
  return entry;
}

/**
 * 本窗口共享的契约传输。返回的对象没有 `close`：共享传输随页面存活，
 * 某个客户端 `$close()` / `dispose()` 不会断开别人。
 */
export function getSharedTransport(): ClientTransport {
  return sharedEntry().outer;
}

/**
 * 把本窗口共享的契约传输换成给定的传输（Go 宿主经回环 WebSocket，docs/design/core-host-decoupling.md §5.2）。
 * 视图只在 `services/api.ts` 里、建客户端之前调用；之前装的传输会被关闭。
 */
export function installSharedTransport(transport: ClientTransport): void {
  const entry = sharedEntry();
  const previous = entry.inner;
  entry.inner = transport;
  if (previous !== transport) previous.close?.();
}

/** 测试用：丢掉共享传输（关闭底层连接），下次 getSharedTransport 重新建 */
export function resetSharedTransportForTest(): void {
  store[SHARED_KEY]?.inner.close?.();
  store[SHARED_KEY] = undefined;
}

/**
 * 应用契约的类型化客户端。每个视图包只在 `services/api.ts` 调一次（docs §11.1：
 * 视图只经 createClient 访问内核，且集中在一个文件里）。
 */
export function createAppClient(
  transport: ClientTransport = getSharedTransport(),
  options?: ClientOptions,
): AppClient {
  return createClient(appContract, transport, options);
}
