/**
 * mkNomiHostPreload —— 在 Electron preload 里暴露 `window.nomiHost`：只放**不能做成契约调用**的宿主能力
 * （docs/design/core-host-decoupling.md §8、§12 P1b）。
 *
 * 现在只有一项：
 * - `pathForFile(file)`：拖入 / 粘贴的 `File` → 本机绝对路径（`webUtils.getPathForFile`）。它只能在 preload
 *   里对真实的 File 对象调用，File 也不能跨进程序列化，所以不进契约。拿到路径后视图照常经契约
 *   （`desktop.dropFile` 等）交给内核；渲染层不能凭空伪造路径，因为只有真实拖入的 File 才有路径。
 *
 * 不发任何 IPC：这里只有本地计算，所有对内核的调用都走 `window.nomiTransport`。
 */

import type { PreloadContextBridgeLike, PreloadWebUtilsLike } from './types';

/** = 视图侧读取的全局名（`services/api.ts` 的 `hostPathForFile`） */
export const NOMI_HOST_BRIDGE_NAME = 'nomiHost';

export interface NomiHostBridge {
  /** 真实 File → 本机路径；不是本地文件（如剪贴板截图）时为空串 */
  pathForFile(file: File): string;
}

export interface MkNomiHostPreloadOptions {
  contextBridge: PreloadContextBridgeLike;
  webUtils: PreloadWebUtilsLike;
  /** 挂到 window 上的 key，默认 `nomiHost` */
  bridgeName?: string;
}

/** 生成并挂载宿主能力桥；返回被暴露的对象引用（供测试断言） */
export function mkNomiHostPreload(opts: MkNomiHostPreloadOptions): NomiHostBridge {
  const api: NomiHostBridge = {
    pathForFile: (file) => {
      try {
        return opts.webUtils.getPathForFile(file) || '';
      } catch {
        // 不是 File（渲染层传了伪造对象）或没有本地路径
        return '';
      }
    },
  };
  opts.contextBridge.exposeInMainWorld(opts.bridgeName ?? NOMI_HOST_BRIDGE_NAME, api);
  return api;
}
