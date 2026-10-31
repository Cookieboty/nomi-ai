/**
 * 本窗口唯一的应用契约客户端（docs/design/core-host-decoupling.md §4.1、§11.1、§12 P1b）。
 *
 * - `api`：`createAppClient()` 建在窗口共享的契约传输上，与 AIProvider 里的 `ClientAIClient` 共用一个会话；
 *   视图里只有这个文件建客户端，其余代码 `import { api } from '…/services/api'`；
 * - 传输只在这里选（与 ai-chat 相同）：有 preload 桥（`window.nomiTransport`，Electron）就用它；没有桥、且是开发构建
 *   并且开发服务器注入了 `window.nomiDevTransport`（`pnpm dev:web`，token 在打印的地址片段里）时，以桌面角色界面（`mascot`）经 WebSocket 连开发态
 *   内核。浏览器里没有透明窗口，要用窗口对象的过程返回 UNAVAILABLE，调用方按「没有窗口」处理。生产构建里
 *   `import.meta.env.DEV` 为 false，这段代码与 WebSocket 传输一起被摇掉；
 * - Go 宿主（apps/desktop-go，Wails 没有 preload）：同一份构建产物，运行时识别——没有 preload 桥、页面地址片段里有
 *   宿主给的 WebSocket 地址与 token（`resolveHostTransport`，只认 127.0.0.1）时经 WebSocket 连 Go 内核，视同在宿主窗口里；
 * - `hasTransport()`：有没有可用的契约传输（浏览器预览 / 测试里为 false，调用方据此退回本地状态）；
 * - `hasWindowHost()`：是不是在宿主的桌面角色窗口里（有 preload 桥）。WebSocket 开发页里为 false：窗口相关的调用
 *   （拖拽、点击穿透、窗口大小）不发；
 * - `hostDropFile(file)`：拖到桌面角色身上的文件交给内核（preload 的 `window.nomiHost` 解析路径并提交，
 *   视图选不了路径，所以不走契约）；
 * - `installHostBackends()`：入口最先调用一次，把契约接到共享包（`@nomi-ai/ui`、`@nomi-ai/voice`）
 *   留的注入点上；每个域一个文件（`./hostBackends/<域>.ts`），域代理只改自己的那个。
 *
 * 视图里只有本文件决定走哪条传输（判定函数收口在 `@nomi-ai/ai-sdk-client` 的 hostTransport，两个窗口共用），
 * 也只有本文件读 `window.nomiHost`（eslint 拦下其余位置，见 §11.1）。
 */

import {
  createAppClient,
  hasPreloadBridge,
  hasTransport as hasAnyTransport,
  hasWindowHost as hasWindow,
  installDevTransport,
  installGoHostTransport,
  type AppClient,
} from '@nomi-ai/ai-sdk-client';
import { NOMI_HOST_GLOBAL, resolveHostAssetUrl } from '@nomi-ai/contract/app';

import { installCodingBackends } from './hostBackends/coding';
import { installKnowledgeBackends } from './hostBackends/knowledge';
import { installMascotBackends } from './hostBackends/mascot';
import { installMediaBackends } from './hostBackends/media';
import { installShellBackends } from './hostBackends/shell';

export type { AppClient };

// 传输只在这里选（判定收口在 @nomi-ai/ai-sdk-client 的 hostTransport，与对话窗口同一份）：
// preload 桥（Electron）→ Go 宿主回环 WebSocket（生产也要识别）→ 开发态 WebSocket（仅 DEV 构建，
// 生产构建里 installDevTransport 随这个分支一起被摇掉）。必须在 createAppClient() 之前。
const preloadBridge = hasPreloadBridge();
const goHostTransport = !preloadBridge && installGoHostTransport('mascot');
const devTransport =
  !preloadBridge && !goHostTransport && import.meta.env.DEV && installDevTransport('mascot');

export const api: AppClient = createAppClient();

export function hasTransport(): boolean {
  return hasAnyTransport({
    hasPreload: preloadBridge,
    isGoHost: goHostTransport,
    isDev: devTransport,
  });
}

/** 在宿主的桌面角色窗口里（有 preload 桥，或 Go 宿主）；浏览器开发页里没有窗口可拖、可穿透 */
export function hasWindowHost(): boolean {
  return hasWindow({ hasPreload: preloadBridge, isGoHost: goHostTransport, isDev: devTransport });
}

/** 是不是 Go 宿主（Wails）里的页面 */
export function isGoHost(): boolean {
  return goHostTransport;
}

interface NomiHost {
  dropFile(file: File): boolean;
}

/**
 * 真实拖入的 File → 交给内核临时授权并总结；路径在 preload 里解析。浏览器预览 / 测试里没有桥，
 * 或文件不在本地（网页拖来的内容）时返回 false
 */
export function hostDropFile(file: File): boolean {
  if (typeof window === 'undefined') return false;
  // Go 宿主：路径由宿主从原生拖放事件里拿（WindowFilesDropped），视图这里只确认已交出
  if (goHostTransport) return true;
  const host = (window as unknown as Record<string, NomiHost | undefined>)[NOMI_HOST_GLOBAL];
  try {
    return host?.dropFile(file) ?? false;
  } catch {
    return false;
  }
}

/**
 * 内核给的资源地址 → 本页能加载的地址：Go 宿主里 `chat-asset://` / `character-pack://` 换成资产服务器网关，
 * 其余情况原样返回
 */
export function hostAssetUrl(url: string): string {
  return goHostTransport ? resolveHostAssetUrl(url) : url;
}

let installed = false;

/** 入口（main.tsx / index.tsx）在 initTheme / initLocale 之前调用；重复调用无效 */
export function installHostBackends(): void {
  if (installed) return;
  installed = true;
  if (!hasTransport()) return;
  installMediaBackends(api);
  installShellBackends(api);
  installCodingBackends(api);
  installKnowledgeBackends(api);
  // 互动设置推给桌面角色窗口控制器：浏览器开发页里没有窗口，只存本地
  if (hasWindowHost()) installMascotBackends(api);
}
