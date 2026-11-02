/**
 * 本窗口唯一的应用契约客户端（docs/design/core-host-decoupling.md §4.1、§11.1、§12 P1b）。
 *
 * - `api`：`createAppClient()` 建在窗口共享的契约传输上，与 AIProvider 里的 `ClientAIClient` 共用一个会话；
 *   视图里只有这个文件建客户端，其余代码 `import { api } from '…/services/api'`；
 * - 传输只在这里选：有 preload 桥（`window.nomiTransport`，Electron）就用它；没有桥、且是开发构建并且开发服务器
 *   注入了 `window.nomiDevTransport`（`pnpm dev:web`，只有地址；token 在打印的地址片段里）时，经 WebSocket 连开发态
 *   内核（§5.2、§11.3）。生产构建里
 *   `import.meta.env.DEV` 为 false，这段代码与 WebSocket 传输一起被摇掉；
 * - Go 宿主（apps/desktop-go，Wails 没有 preload）：同一份构建产物，运行时识别——没有 preload 桥、页面地址片段里有
 *   宿主给的 WebSocket 地址与 token（`resolveHostTransport`，只认 127.0.0.1）时经 WebSocket 连 Go 内核，视同在宿主窗口里；
 * - `hasTransport()`：有没有可用的契约传输（浏览器预览 / 测试里为 false，调用方据此退回本地状态）；
 * - `hostPathForFile(file)`：拖入 / 粘贴文件的本机路径（preload 的 `window.nomiHost`，唯一不走契约的宿主能力）；
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

// 传输只在这里选（判定收口在 @nomi-ai/ai-sdk-client 的 hostTransport，与桌面角色窗口同一份）：
// preload 桥（Electron）→ Go 宿主回环 WebSocket（生产也要识别）→ 开发态 WebSocket（仅 DEV 构建，
// 生产构建里 installDevTransport 随这个分支一起被摇掉）。必须在 createAppClient() 之前。
const preloadBridge = hasPreloadBridge();
const goHostTransport = !preloadBridge && installGoHostTransport('chat');
const devTransport =
  !preloadBridge && !goHostTransport && import.meta.env.DEV && installDevTransport('chat');

export const api: AppClient = createAppClient();

/** 是不是 Go 宿主（Wails）里的页面：Windows / Linux 上对话窗口无边框，窗口按钮由标题栏自绘 */
export function isGoHost(): boolean {
  return goHostTransport;
}

export function hasTransport(): boolean {
  return hasAnyTransport({
    hasPreload: preloadBridge,
    isGoHost: goHostTransport,
    isDev: devTransport,
  });
}

interface NomiHost {
  pathForFile(file: File): string;
}

/**
 * Go 宿主：Wails 没有 preload，路径来自原生拖放事件——宿主收到 WindowFilesDropped 后往页面派发
 * `nomi:host-files`（detail = 路径数组），这里按文件名配对。DOM 的 drop 与原生回调谁先到不固定，所以先缓存、取时稍等
 */
const HOST_FILES_EVENT = 'nomi:host-files';
const HOST_FILES_TTL_MS = 5_000;
const HOST_FILES_WAIT_MS = 500;
let hostDropped: { path: string; at: number }[] = [];
const hostDropWaiters = new Set<() => void>();

/** 宿主送来的一个拖入文件：本机路径 + 一次性临时地址（拖放时有，粘贴时没有）+ 大小 */
export interface HostDroppedFile {
  path: string;
  name: string;
  url?: string;
  size?: number;
}
/**
 * macOS / Linux 上 Wails 的原生拖放层接走了 drop：网页收不到 DOM drop、没有 File，只有宿主送来的路径。
 * 宿主事件之后这么久内（以及之前 1 秒内）网页都没收到带文件的 drop / paste，就当作「只有宿主」交给订阅方
 */
const HOST_ONLY_WAIT_MS = 300;
const DOM_FILES_WINDOW_MS = 1_000;
let lastDomFilesAt = -Infinity;
const hostOnlyListeners = new Set<(files: HostDroppedFile[]) => void>();

/** 订阅只有宿主路径的拖入文件（macOS / Linux 的 Go 版）；返回取消函数 */
export function onHostOnlyFiles(fn: (files: HostDroppedFile[]) => void): () => void {
  hostOnlyListeners.add(fn);
  return () => hostOnlyListeners.delete(fn);
}

type HostFileDetail = string | { path?: unknown; url?: unknown; size?: unknown };

/** nomi:host-files 的 detail：路径数组（粘贴）或 {path,url,size} 数组（拖放） */
export function parseHostFiles(detail: unknown): HostDroppedFile[] {
  if (!Array.isArray(detail)) return [];
  const out: HostDroppedFile[] = [];
  for (const d of detail as HostFileDetail[]) {
    const path = typeof d === 'string' ? d : typeof d?.path === 'string' ? d.path : '';
    if (!path) continue;
    const url =
      typeof d === 'object' && typeof d.url === 'string' && d.url.startsWith('/__nomi/drop/')
        ? d.url
        : undefined;
    const size = typeof d === 'object' && typeof d.size === 'number' ? d.size : undefined;
    out.push({
      path,
      name: path.split(/[\\/]/).pop() ?? '',
      ...(url ? { url } : {}),
      ...(size !== undefined ? { size } : {}),
    });
  }
  return out;
}
if (goHostTransport) {
  // 拖放目标：Wails 只把落在 data-file-drop-target 元素上的文件交给宿主
  const mark = () => document.body?.setAttribute('data-file-drop-target', '');
  if (document.body) mark();
  else document.addEventListener('DOMContentLoaded', mark, { once: true });
  // 粘贴的文件 WebKit 不给路径：请宿主读系统剪贴板里的文件路径，同样经 nomi:host-files 送回
  window.addEventListener(
    'paste',
    (e) => {
      if (!e.clipboardData?.files.length) return;
      const w = window as unknown as {
        webkit?: { messageHandlers?: { external?: { postMessage(m: string): void } } };
        chrome?: { webview?: { postMessage(m: string): void } };
      };
      try {
        (w.webkit?.messageHandlers?.external ?? w.chrome?.webview)?.postMessage(
          'nomi:clipboard-files',
        );
      } catch {
        /* 没有宿主消息通道：粘贴的文件没有路径 */
      }
    },
    true,
  );
  // 网页自己收到了带文件的 drop / paste：宿主送来的路径按文件名配对，不另走「只有宿主」
  const markDomFiles = (e: DragEvent | ClipboardEvent) => {
    const files = 'dataTransfer' in e ? e.dataTransfer?.files : e.clipboardData?.files;
    if (files?.length) lastDomFilesAt = Date.now();
  };
  window.addEventListener('drop', markDomFiles, true);
  window.addEventListener('paste', markDomFiles, true);
  window.addEventListener(HOST_FILES_EVENT, (e) => {
    const files = parseHostFiles((e as CustomEvent<unknown>).detail);
    if (!files.length) return;
    const now = Date.now();
    hostDropped = [
      ...hostDropped.filter((d) => now - d.at < HOST_FILES_TTL_MS),
      ...files.map((f) => ({ path: f.path, at: now })),
    ];
    for (const w of [...hostDropWaiters]) w();
    // 只有拖放（带临时地址）才可能是「只有宿主」；粘贴总有 DOM 的 paste
    if (!files.some((f) => f.url)) return;
    setTimeout(() => {
      if (Date.now() - lastDomFilesAt < DOM_FILES_WINDOW_MS + HOST_ONLY_WAIT_MS) return;
      // 这批路径不会再有 File 来配对，从配对缓存里拿掉
      const taken = new Set(files.map((f) => f.path));
      hostDropped = hostDropped.filter((d) => !taken.has(d.path));
      for (const fn of [...hostOnlyListeners]) fn(files);
    }, HOST_ONLY_WAIT_MS);
  });
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? '';

/** 取出（并消费）一个文件名相同、还没过期的宿主路径 */
function takeHostDropped(name: string): string {
  const now = Date.now();
  const i = hostDropped.findIndex(
    (d) => now - d.at < HOST_FILES_TTL_MS && baseName(d.path) === name,
  );
  if (i < 0) return '';
  const [hit] = hostDropped.splice(i, 1);
  return hit!.path;
}

/**
 * 真实 File → 本机绝对路径；浏览器预览 / 测试里没有桥，或文件不在本地（网页拖来的内容）时为空串。
 * Go 宿主：拖入的文件来自原生拖放事件，粘贴的文件来自系统剪贴板（Linux 读不到，没有路径）
 */
export async function hostPathForFile(file: File): Promise<string> {
  if (typeof window === 'undefined') return '';
  if (goHostTransport) {
    const hit = takeHostDropped(file.name);
    if (hit) return hit;
    return new Promise<string>((resolve) => {
      const done = () => {
        const p = takeHostDropped(file.name);
        if (!p) return;
        hostDropWaiters.delete(done);
        clearTimeout(timer);
        resolve(p);
      };
      const timer = setTimeout(() => {
        hostDropWaiters.delete(done);
        resolve('');
      }, HOST_FILES_WAIT_MS);
      hostDropWaiters.add(done);
    });
  }
  const host = (window as unknown as Record<string, NomiHost | undefined>)[NOMI_HOST_GLOBAL];
  try {
    return host?.pathForFile(file) ?? '';
  } catch {
    return '';
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
  installMascotBackends(api);
}
