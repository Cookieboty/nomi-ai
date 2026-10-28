/**
 * 看板娘窗口的 preload（docs/design/core-host-decoupling.md §5.2、§8）。
 *
 * 只暴露两个对象：
 * - `window.nomiTransport`：契约传输，只放行 contract:request / contract:frame 两个通道；
 *   视图对内核的全部调用与事件都走它（`services/api.ts` 的类型化客户端）；
 * - `window.nomiHost`：不能做成契约调用的宿主能力（拖入文件的本机路径；`dropFile(file)` 在 preload 里
 *   解析路径并经 `desktop:drop-file` 提交，视图代码选不了路径）。
 */
import { mkNomiHostPreload, mkNomiTransportPreload } from '@nomi-ai/ai-sdk-client/preload';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

mkNomiTransportPreload({ contextBridge, ipcRenderer });
mkNomiHostPreload({ contextBridge, webUtils, ipcRenderer });
