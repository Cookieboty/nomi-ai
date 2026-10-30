/**
 * mkNomiHostPreload —— 在 Electron preload 里暴露 `window.nomiHost`：只放**不能做成契约调用**的宿主能力
 * （docs/design/core-host-decoupling.md §8、§12 P1b）。
 *
 * - `pathForFile(file)`：拖入 / 粘贴的 `File` → 本机绝对路径（`webUtils.getPathForFile`）。它只能在 preload
 *   里对真实的 File 对象调用，File 也不能跨进程序列化，所以不进契约。对话窗口拿路径做附件。
 * - `dropFile(file)`（只有传了 `ipcRenderer` 的 preload 才会提交，即桌面角色窗口）：拖到桌面角色身上的文件。
 *   路径的解析与提交**都在 preload 里**完成，经专用通道 `desktop:drop-file` 直接发给主进程
 *   （host/nomiHostIpc.ts）。视图只交出 File，选不了路径：页面里的脚本（XSS、被篡改的依赖）就算拿到
 *   这个对象，也只能提交用户真实拖进来的文件。所以它不是契约过程——契约过程的入参由视图决定。
 *
 * 除 `desktop:drop-file` 外不发任何 IPC：其余对内核的调用都走 `window.nomiTransport`。
 */

import type { PreloadContextBridgeLike, PreloadWebUtilsLike } from './types';

/** = 视图侧读取的全局名（`services/api.ts` 的 `hostPathForFile`） */
export const NOMI_HOST_BRIDGE_NAME = 'nomiHost';

/** preload → 主进程：桌面角色窗口拖入文件的本机路径（主进程 host/nomiHostIpc.ts 校验发送方） */
export const NOMI_HOST_DROP_FILE_CHANNEL = 'desktop:drop-file';

export interface NomiHostBridge {
  /** 真实 File → 本机路径；不是本地文件（如剪贴板截图）时为空串 */
  pathForFile(file: File): string;
  /** 把真实拖入的 File 交给内核总结；没有本地路径或本窗口不能提交时返回 false */
  dropFile(file: File): boolean;
}

/** `electron.ipcRenderer` 的子集：只用 send */
export interface PreloadIpcSendLike {
  send: (channel: string, ...args: unknown[]) => void;
}

export interface MkNomiHostPreloadOptions {
  contextBridge: PreloadContextBridgeLike;
  webUtils: PreloadWebUtilsLike;
  /** 只有桌面角色窗口的 preload 传：`dropFile` 经它提交；不传时 `dropFile` 恒为 false */
  ipcRenderer?: PreloadIpcSendLike;
  /** 挂到 window 上的 key，默认 `nomiHost` */
  bridgeName?: string;
}

/** 生成并挂载宿主能力桥；返回被暴露的对象引用（供测试断言） */
export function mkNomiHostPreload(opts: MkNomiHostPreloadOptions): NomiHostBridge {
  const pathForFile = (file: File): string => {
    try {
      return opts.webUtils.getPathForFile(file) || '';
    } catch {
      // 不是 File（渲染层传了伪造对象）或没有本地路径
      return '';
    }
  };
  const api: NomiHostBridge = {
    pathForFile,
    dropFile: (file) => {
      const ipc = opts.ipcRenderer;
      if (!ipc) return false;
      const p = pathForFile(file);
      if (!p) return false;
      // 只发一个参数：路径来自 webUtils，不来自视图
      ipc.send(NOMI_HOST_DROP_FILE_CHANNEL, p);
      return true;
    },
  };
  opts.contextBridge.exposeInMainWorld(opts.bridgeName ?? NOMI_HOST_BRIDGE_NAME, api);
  return api;
}
