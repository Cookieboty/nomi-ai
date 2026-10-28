/**
 * 窗口共享的契约传输与应用客户端（docs/design/core-host-decoupling.md §5、§12 P1b）。
 *
 * 一个窗口只开一个契约会话：`ClientAIClient` 与视图的 `services/api.ts`（`createAppClient()`）
 * 都用 `getSharedTransport()`，帧经同一个客户端 id 收发；页面刷新后新页面重新建。
 *
 * 读桥是惰性的：第一次调用 / 订阅时才读 `window.nomiTransport`，没就绪时调用以 BRIDGE_MISSING 失败、
 * 订阅不生效，下次再试（浏览器预览、测试里不抛在 import 时）。
 */

import {
  createClient,
  createIpcClientTransport,
  PushStream,
  type Client,
  type ClientOptions,
  type ClientTransport,
  type FrameClientTransport,
} from '@nomi-ai/contract';
import { appContract, NOMI_TRANSPORT_GLOBAL, type AppContract } from '@nomi-ai/contract/app';

import { getGlobalBridge } from './IPCBridge';

/** 视图侧的应用契约客户端类型 */
export type AppClient = Client<AppContract>;

/** 读 window 上的桥：用到时才读，成功后缓存 */
export function lazyGlobalTransport(bridgeName: string = NOMI_TRANSPORT_GLOBAL): ClientTransport {
  let inner: FrameClientTransport | undefined;
  const get = (): FrameClientTransport => {
    inner ??= createIpcClientTransport(getGlobalBridge(bridgeName));
    return inner;
  };
  return {
    call(name, input, opts) {
      try {
        return get().call(name, input, opts);
      } catch (err) {
        return Promise.reject(err);
      }
    },
    stream(name, input, opts) {
      try {
        return get().stream(name, input, opts);
      } catch (err) {
        const failed = new PushStream<unknown, unknown>();
        failed.fail(err);
        return failed;
      }
    },
    subscribe(event, fn) {
      try {
        return get().subscribe(event, fn);
      } catch {
        return () => undefined;
      }
    },
    close() {
      inner?.close();
      inner = undefined;
    },
  };
}

interface SharedEntry {
  inner: ClientTransport;
  outer: ClientTransport;
}

const shared = new Map<string, SharedEntry>();

function sharedEntry(bridgeName: string): SharedEntry {
  let entry = shared.get(bridgeName);
  if (!entry) {
    // outer 每次调用时才读 entry.inner：installSharedTransport 换掉内层后，已经建好的客户端也走新传输
    const e: SharedEntry = {
      inner: lazyGlobalTransport(bridgeName),
      outer: {
        call: (name, input, opts) => e.inner.call(name, input, opts),
        stream: (name, input, opts) => e.inner.stream(name, input, opts),
        subscribe: (event, fn) => e.inner.subscribe(event, fn),
      },
    };
    entry = e;
    shared.set(bridgeName, entry);
  }
  return entry;
}

/**
 * 本窗口共享的契约传输（按桥名各一个）。返回的对象没有 `close`：共享传输随页面存活，
 * 某个客户端 `$close()` / `dispose()` 不会断开别人。
 */
export function getSharedTransport(bridgeName: string = NOMI_TRANSPORT_GLOBAL): ClientTransport {
  return sharedEntry(bridgeName).outer;
}

/**
 * 把本窗口共享的契约传输换成给定的传输（没有 preload 桥的页面，例如开发态在浏览器里经 WebSocket 连内核，
 * docs/design/core-host-decoupling.md §5.2）。视图只在 `services/api.ts` 里、建客户端之前调用；
 * 原来的惰性桥还没用过，直接丢掉。
 */
export function installSharedTransport(
  transport: ClientTransport,
  bridgeName: string = NOMI_TRANSPORT_GLOBAL,
): void {
  const entry = sharedEntry(bridgeName);
  const previous = entry.inner;
  entry.inner = transport;
  if (previous !== transport) previous.close?.();
}

/** 测试用：丢掉共享传输（关闭底层连接），下次 getSharedTransport 重新建 */
export function resetSharedTransportForTest(): void {
  for (const { inner } of shared.values()) inner.close?.();
  shared.clear();
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
