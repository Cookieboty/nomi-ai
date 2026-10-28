/**
 * mkNomiTransportPreload —— 在 Electron preload 里暴露契约传输 `window.nomiTransport`
 * （docs/design/core-host-decoupling.md §5.2、§8）。
 *
 * 只放行契约的两个通道：`contract:request`（invoke，视图 → 内核）与 `contract:frame`
 * （内核 → 视图的帧）。其它通道一律拒绝，所以页面拿到这个对象也发不出任意 IPC。
 * 形状满足 `@nomi-ai/contract` 的 `IpcBridgeLike`，`ClientAIClient` 直接用它建传输。
 *
 * 通过参数注入 `contextBridge / ipcRenderer`，不静态引 `electron`（测试 & lint 友好）。
 * 通道名与全局名在这里写死而不 import `@nomi-ai/contract`：preload 按 CJS 打包，import 会把
 * 整个契约（含 zod）拖进每个窗口的 preload；与契约常量一致由单测保证。
 */

import type { PreloadContextBridgeLike, PreloadIpcRendererLike } from './mkAiPreload';

/** = `@nomi-ai/contract` 的 IPC_REQUEST_CHANNEL / IPC_FRAME_CHANNEL */
export const NOMI_TRANSPORT_REQUEST_CHANNEL = 'contract:request';
export const NOMI_TRANSPORT_FRAME_CHANNEL = 'contract:frame';
/** = `@nomi-ai/contract/app` 的 NOMI_TRANSPORT_GLOBAL */
export const NOMI_TRANSPORT_BRIDGE_NAME = 'nomiTransport';

export interface MkNomiTransportPreloadOptions {
  contextBridge: PreloadContextBridgeLike;
  ipcRenderer: PreloadIpcRendererLike;
  /** 挂到 window 上的 key，默认 `nomiTransport` */
  bridgeName?: string;
}

export interface NomiTransportBridge {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, fn: (payload: unknown) => void): () => void;
}

function assertContractChannel(channel: string, allowed: string): void {
  if (channel !== allowed) {
    throw new Error(`[nomi-transport] channel '${String(channel)}' is not allowed`);
  }
}

/** 生成并挂载契约传输桥；返回被暴露的对象引用（供测试断言） */
export function mkNomiTransportPreload(opts: MkNomiTransportPreloadOptions): NomiTransportBridge {
  const bridgeName = opts.bridgeName ?? NOMI_TRANSPORT_BRIDGE_NAME;
  const api: NomiTransportBridge = {
    invoke: (channel, payload) => {
      assertContractChannel(channel, NOMI_TRANSPORT_REQUEST_CHANNEL);
      // 只转发一个载荷：渲染层不能借多余参数夹带数据
      return opts.ipcRenderer.invoke(NOMI_TRANSPORT_REQUEST_CHANNEL, payload);
    },
    on: (channel, fn) => {
      assertContractChannel(channel, NOMI_TRANSPORT_FRAME_CHANNEL);
      const wrapped = (_event: unknown, payload: unknown) => fn(payload);
      opts.ipcRenderer.on(NOMI_TRANSPORT_FRAME_CHANNEL, wrapped);
      return () => {
        const off = opts.ipcRenderer.off ?? opts.ipcRenderer.removeListener;
        off?.call(opts.ipcRenderer, NOMI_TRANSPORT_FRAME_CHANNEL, wrapped);
      };
    },
  };
  opts.contextBridge.exposeInMainWorld(bridgeName, api);
  return api;
}
