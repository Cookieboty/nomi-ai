/**
 * 本窗口唯一的应用契约客户端（docs/design/core-host-decoupling.md §4.1、§11.1、§12 P1b）。
 *
 * - `api`：`createAppClient()` 建在窗口共享的契约传输上，与 AIProvider 里的 `ClientAIClient` 共用一个会话；
 *   视图里只有这个文件建客户端，其余代码 `import { api } from '…/services/api'`；
 * - 传输只在这里选（与 ai-chat 相同）：有 preload 桥（`window.nomiTransport`，Electron）就用它；没有桥、且是开发构建
 *   并且开发服务器注入了 `window.nomiDevTransport`（`pnpm dev:web`）时，以看板娘界面（`mascot`）经 WebSocket 连开发态
 *   内核。浏览器里没有透明窗口，要用窗口对象的过程返回 UNAVAILABLE，调用方按「没有窗口」处理。生产构建里
 *   `import.meta.env.DEV` 为 false，这段代码与 WebSocket 传输一起被摇掉；
 * - `hasTransport()`：有没有可用的契约传输（浏览器预览 / 测试里为 false，调用方据此退回本地状态）；
 * - `hasWindowHost()`：是不是在宿主的看板娘窗口里（有 preload 桥）。WebSocket 开发页里为 false：窗口相关的调用
 *   （拖拽、点击穿透、窗口大小）不发；
 * - `hostDropFile(file)`：拖到看板娘身上的文件交给内核（preload 的 `window.nomiHost` 解析路径并提交，
 *   视图选不了路径，所以不走契约）；
 * - `installHostBackends()`：入口最先调用一次，把契约接到共享包（`@nomi-ai/ui`、`@nomi-ai/voice`）
 *   留的注入点上；每个域一个文件（`./hostBackends/<域>.ts`），域代理只改自己的那个。
 *
 * 视图里只有本文件可以读 `window.nomiTransport` / `window.nomiHost`（eslint 拦下其余位置，见 §11.1）。
 */

import { createAppClient, installSharedTransport, type AppClient } from '@nomi-ai/ai-sdk-client';
import { createWebSocketClientTransport } from '@nomi-ai/contract';
import {
  NOMI_DEV_TRANSPORT_GLOBAL,
  NOMI_HOST_GLOBAL,
  NOMI_TRANSPORT_GLOBAL,
  type DevTransportConfig,
} from '@nomi-ai/contract/app';

import { installCodingBackends } from './hostBackends/coding';
import { installKnowledgeBackends } from './hostBackends/knowledge';
import { installMascotBackends } from './hostBackends/mascot';
import { installMediaBackends } from './hostBackends/media';
import { installShellBackends } from './hostBackends/shell';

export type { AppClient };

function hasPreloadBridge(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as Record<string, unknown>)[NOMI_TRANSPORT_GLOBAL] === 'object'
  );
}

/** 开发服务器注入的 WebSocket 配置（只在开发构建里读） */
function devTransportConfig(): DevTransportConfig | null {
  if (typeof window === 'undefined') return null;
  const raw = (window as unknown as Record<string, unknown>)[NOMI_DEV_TRANSPORT_GLOBAL];
  if (!raw || typeof raw !== 'object') return null;
  const { url, token } = raw as Partial<DevTransportConfig>;
  return typeof url === 'string' && typeof token === 'string' ? { url, token } : null;
}

let devTransport = false;
// 必须在 createAppClient() 之前：模块加载时建的客户端从此走 WebSocket
if (import.meta.env.DEV && !hasPreloadBridge()) {
  const config = devTransportConfig();
  if (config) {
    installSharedTransport(createWebSocketClientTransport({ ...config, surface: 'mascot' }));
    devTransport = true;
  }
}

export const api: AppClient = createAppClient();

export function hasTransport(): boolean {
  return devTransport || hasPreloadBridge();
}

/** 在宿主的看板娘窗口里（有 preload 桥）；浏览器开发页里没有窗口可拖、可穿透 */
export function hasWindowHost(): boolean {
  return hasPreloadBridge();
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
  const host = (window as unknown as Record<string, NomiHost | undefined>)[NOMI_HOST_GLOBAL];
  try {
    return host?.dropFile(file) ?? false;
  } catch {
    return false;
  }
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
  // 互动设置推给看板娘窗口控制器：浏览器开发页里没有窗口，只存本地
  if (hasWindowHost()) installMascotBackends(api);
}
