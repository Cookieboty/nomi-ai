/**
 * 本窗口唯一的应用契约客户端（docs/design/core-host-decoupling.md §4.1、§11.1、§12 P1b）。
 *
 * - `api`：`createAppClient()` 建在窗口共享的契约传输上，与 AIProvider 里的 `ClientAIClient` 共用一个会话；
 *   视图里只有这个文件建客户端，其余代码 `import { api } from '…/services/api'`；
 * - 传输只在这里选（与 ai-chat 相同）：Go 宿主（apps/desktop-go，Wails）把回环 WebSocket 地址与 token 放在页面地址
 *   片段里（`resolveHostTransport`，只认 127.0.0.1），读到就以桌面角色界面（`mascot`）连 Go 内核；
 * - `hasTransport()` / `hasWindowHost()` / `isGoHost()`：是不是在 Nomi 的桌面角色窗口里（三者相同）。浏览器预览、
 *   测试里为 false，调用方据此退回本地状态，窗口相关的调用（拖拽、点击穿透、窗口大小）不发；
 * - `hostDropFile(file)`：拖到桌面角色身上的文件交给内核（路径由宿主从原生拖放事件里拿）；
 * - `installHostBackends()`：入口最先调用一次，把契约接到共享包（`@nomi-ai/ui`、`@nomi-ai/voice`）
 *   留的注入点上；每个域一个文件（`./hostBackends/<域>.ts`），域代理只改自己的那个。
 *
 * 视图里只有本文件决定走哪条传输（判定收口在 `@nomi-ai/ai-sdk-client` 的 hostTransport，两个窗口共用）。
 */

import { createAppClient, installGoHostTransport, type AppClient } from '@nomi-ai/ai-sdk-client';
import { resolveHostAssetUrl } from '@nomi-ai/contract/app';

import { installCodingBackends } from './hostBackends/coding';
import { installKnowledgeBackends } from './hostBackends/knowledge';
import { installMascotBackends } from './hostBackends/mascot';
import { installMediaBackends } from './hostBackends/media';
import { installShellBackends } from './hostBackends/shell';

export type { AppClient };

// 必须在 createAppClient() 之前
const goHostTransport = installGoHostTransport('mascot');

export const api: AppClient = createAppClient();

/** 有没有可用的契约传输（浏览器预览 / 测试里为 false） */
export function hasTransport(): boolean {
  return goHostTransport;
}

/** 在 Nomi 的桌面角色窗口里；浏览器预览里没有窗口可拖、可穿透 */
export function hasWindowHost(): boolean {
  return goHostTransport;
}

/** 是不是 Go 宿主（Wails）里的页面 */
export function isGoHost(): boolean {
  return goHostTransport;
}

/**
 * 真实拖入的 File → 交给内核临时授权并总结：路径由宿主从原生拖放事件里拿（WindowFilesDropped），
 * 视图这里只确认已交出。不在 Nomi 窗口里（浏览器预览 / 测试）时返回 false
 */
export function hostDropFile(_file: File): boolean {
  return goHostTransport;
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
  installMascotBackends(api);
}
