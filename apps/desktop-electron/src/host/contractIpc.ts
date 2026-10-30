/**
 * 契约的 Electron IPC 传输（docs/design/core-host-decoupling.md §5.2、§8）。
 *
 * 把内核的 Router 挂到 `contract:request` / `contract:frame` 两个通道上（`@nomi-ai/contract` 的
 * `createIpcServerTransport`，底层是 host/electronIpcAdapter.ts 实现的 ai-runtime `IpcAdapter`），视图经 preload 暴露的
 * `window.nomiTransport` 访问。
 *
 * - 调用者：`resolveAiCaller`（host/ipcSenderGuard.ts）按 sender URL 判定 surface 与 trusted，
 *   不受信的发送方一律拒绝；`dangerous` 过程只接受 trusted 调用者（契约内置守卫）；
 * - 会话生命周期：服务端看不到渲染进程里旧客户端的消失，所以主框架的跨文档导航**提交**时
 *   （含刷新）、渲染进程退出与 webContents 销毁时调用 `disconnect(senderId)`：旧页面的订阅与
 *   进行中的流随之取消。不能在 `did-start-navigation` 断开——security/windowGuards.ts 会在
 *   `will-navigate` 里取消跨文档导航，被取消的导航不换页面，旧客户端仍然在用。
 */

import type { IpcAdapter } from '@nomi-ai/ai-runtime';
import {
  createIpcServerTransport,
  type ContractLogger,
  type IpcInvokeEventLike,
  type IpcServerTransport,
  type Router,
} from '@nomi-ai/contract';
import { app, webContents as electronWebContents } from 'electron';

import { createElectronIpcAdapter } from './electronIpcAdapter';
import { resolveAiCaller } from './ipcSenderGuard';

/** 需要监听的 webContents 能力（Electron WebContents 结构上满足） */
export interface ContractWebContents {
  id: number;
  /** 主框架跨文档导航已提交（页内导航与被取消 / 失败的导航不触发） */
  on(event: 'did-navigate', listener: () => void): unknown;
  on(event: 'render-process-gone', listener: () => void): unknown;
  once(event: 'destroyed', listener: () => void): unknown;
}

/** webContents 来源：现有的全部 + 之后新建的 */
export interface ContractWebContentsSource {
  all(): ContractWebContents[];
  onCreated(fn: (wc: ContractWebContents) => void): () => void;
}

export interface ServeContractOptions {
  router: Router;
  /** 默认 `createElectronIpcAdapter()` */
  adapter?: IpcAdapter;
  /** 默认 Electron 的 `webContents.getAllWebContents()` + `app.on('web-contents-created')` */
  contents?: ContractWebContentsSource;
  /** 默认 `resolveAiCaller` */
  resolveCaller?: (event: IpcInvokeEventLike) => ReturnType<typeof resolveAiCaller>;
  logger?: ContractLogger;
}

export interface ContractIpcHandle {
  transport: IpcServerTransport;
  stop(): void;
}

function electronContents(): ContractWebContentsSource {
  return {
    all: () => electronWebContents.getAllWebContents() as unknown as ContractWebContents[],
    onCreated(fn) {
      const listener = (_event: unknown, wc: unknown) => fn(wc as ContractWebContents);
      app.on('web-contents-created', listener);
      return () => {
        app.off('web-contents-created', listener);
      };
    },
  };
}

export function serveContractOverIpc(opts: ServeContractOptions): ContractIpcHandle {
  const transport = createIpcServerTransport(opts.adapter ?? createElectronIpcAdapter(), {
    resolveCaller: opts.resolveCaller ?? resolveAiCaller,
    logger: opts.logger,
  });
  const stopServe = transport.serve(opts.router);
  const contents = opts.contents ?? electronContents();

  let stopped = false;
  const watched = new WeakSet<ContractWebContents>();
  const watch = (wc: ContractWebContents): void => {
    if (watched.has(wc)) return;
    watched.add(wc);
    // `did-navigate` 只在主框架跨文档导航提交时触发：被取消 / 失败的导航与页内导航
    // （hash / pushState）都不换页面，客户端还在
    wc.on('did-navigate', () => {
      if (!stopped) transport.disconnect(wc.id);
    });
    wc.on('render-process-gone', () => {
      if (!stopped) transport.disconnect(wc.id);
    });
    wc.once('destroyed', () => {
      if (!stopped) transport.disconnect(wc.id);
    });
  };
  for (const wc of contents.all()) watch(wc);
  const offCreated = contents.onCreated(watch);

  return {
    transport,
    stop() {
      if (stopped) return;
      stopped = true;
      offCreated();
      stopServe();
    },
  };
}
