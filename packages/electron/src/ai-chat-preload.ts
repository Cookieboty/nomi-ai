/**
 * 对话窗口的 preload（docs/design/core-host-decoupling.md §5.2、§8）：与看板娘窗口相同，只暴露
 * `window.nomiTransport`（契约传输）与 `window.nomiHost`（拖入 / 粘贴文件的本机路径）。
 * 两个窗口能调哪些过程由契约里的 `surfaces` 与传输层判定的调用者决定，不靠 preload 分别白名单。
 */
import { mkNomiHostPreload, mkNomiTransportPreload } from '@nomi-ai/ai-sdk-client/preload';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

mkNomiTransportPreload({ contextBridge, ipcRenderer });
mkNomiHostPreload({ contextBridge, webUtils });
