/**
 * 本窗口唯一的应用契约客户端（docs/design/core-host-decoupling.md §4.1、§11.1、§12 P1b）。
 *
 * - `api`：`createAppClient()` 建在窗口共享的契约传输上，与 AIProvider 里的 `ClientAIClient` 共用一个会话；
 *   视图里只有这个文件建客户端，其余代码 `import { api } from '…/services/api'`；
 * - 传输只在这里选：有 preload 桥（`window.nomiTransport`，Electron）就用它；没有桥、且是开发构建并且开发服务器
 *   注入了 `window.nomiDevTransport`（`pnpm dev:web`，只有地址；token 在打印的地址片段里）时，经 WebSocket 连开发态
 *   内核（§5.2、§11.3）。生产构建里
 *   `import.meta.env.DEV` 为 false，这段代码与 WebSocket 传输一起被摇掉；
 * - `hasTransport()`：有没有可用的契约传输（浏览器预览 / 测试里为 false，调用方据此退回本地状态）；
 * - `hostPathForFile(file)`：拖入 / 粘贴文件的本机路径（preload 的 `window.nomiHost`，唯一不走契约的宿主能力）；
 * - `installHostBackends()`：入口最先调用一次，把契约接到共享包（`@nomi-ai/ui`、`@nomi-ai/voice`）
 *   留的注入点上；每个域一个文件（`./hostBackends/<域>.ts`），域代理只改自己的那个。
 *
 * 视图里只有本文件可以读 `window.nomiTransport` / `window.nomiHost` / `window.nomiDevTransport`
 *（eslint 拦下其余位置，见 §11.1）。
 */

import { createAppClient, installSharedTransport, type AppClient } from '@nomi-ai/ai-sdk-client';
import { createWebSocketClientTransport } from '@nomi-ai/contract';
import {
  NOMI_DEV_TRANSPORT_GLOBAL,
  NOMI_HOST_GLOBAL,
  NOMI_TRANSPORT_GLOBAL,
  resolveDevTransport,
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

/**
 * 开发态 WebSocket 配置（只在开发构建里读）：地址来自开发服务器注入的全局；token 来自 dev:web 打印的地址里的
 * `#nomi-token=…` 片段（读到后存 sessionStorage 并从地址栏抹掉），页面 HTML 里没有 token
 */
function devTransportConfig(): DevTransportConfig | null {
  if (typeof window === 'undefined') return null;
  const storage = ((): Storage | null => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  })();
  return resolveDevTransport(
    (window as unknown as Record<string, unknown>)[NOMI_DEV_TRANSPORT_GLOBAL],
    {
      hash: window.location.hash,
      storage,
      replaceFragment: (rest) => {
        const { pathname, search } = window.location;
        window.history.replaceState(
          window.history.state,
          '',
          `${pathname}${search}${rest ? `#${rest}` : ''}`,
        );
      },
    },
  );
}

let devTransport = false;
// 必须在 createAppClient() 之前：模块加载时建的客户端从此走 WebSocket
if (import.meta.env.DEV && !hasPreloadBridge()) {
  const config = devTransportConfig();
  if (config) {
    installSharedTransport(createWebSocketClientTransport({ ...config, surface: 'chat' }));
    devTransport = true;
  }
}

export const api: AppClient = createAppClient();

export function hasTransport(): boolean {
  return devTransport || hasPreloadBridge();
}

interface NomiHost {
  pathForFile(file: File): string;
}

/** 真实 File → 本机绝对路径；浏览器预览 / 测试里没有桥，或文件不在本地（网页拖来的内容）时为空串 */
export function hostPathForFile(file: File): string {
  if (typeof window === 'undefined') return '';
  const host = (window as unknown as Record<string, NomiHost | undefined>)[NOMI_HOST_GLOBAL];
  try {
    return host?.pathForFile(file) ?? '';
  } catch {
    return '';
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
  installMascotBackends(api);
}
