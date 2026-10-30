/**
 * 看板娘窗口与对话窗口共用的 preload（docs/design/core-host-decoupling.md §5.2、§8）。
 *
 * 只暴露两个对象：
 * - `window.nomiTransport`：契约传输，只放行 contract:request / contract:frame 两个通道；
 *   视图对内核的全部调用与事件都走它（`services/api.ts` 的类型化客户端）。两个窗口能调哪些过程由契约的
 *   `surfaces` 与传输层判定的调用者决定，不靠 preload 分别白名单；
 * - `window.nomiHost`：不能做成契约调用的宿主能力（拖入 / 粘贴文件的本机路径；`dropFile(file)` 在 preload 里
 *   解析路径并经 `desktop:drop-file` 提交，视图代码选不了路径）。
 *
 * `dropFile` 只属于看板娘窗口：主进程建窗口时经 `additionalArguments` 传 `--nomi-window=mascot`，只有这时
 * 才把 ipcRenderer 交给 nomiHost；主进程收到后仍按发送方再校验（host/nomiHostIpc.ts）。
 */
import {
  mkNomiHostPreload,
  mkNomiTransportPreload,
  nomiWindowKindFromArgv,
} from '@nomi-ai/ai-sdk-client/preload';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const isMascotWindow = nomiWindowKindFromArgv(process.argv) === 'mascot';

mkNomiTransportPreload({ contextBridge, ipcRenderer });
mkNomiHostPreload({ contextBridge, webUtils, ...(isMascotWindow ? { ipcRenderer } : {}) });
