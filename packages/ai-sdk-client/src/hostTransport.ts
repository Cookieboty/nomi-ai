/**
 * 视图窗口的契约传输选择（docs/design/core-host-decoupling.md §5.2、§11.1、§11.3、§12 P1b）。
 *
 * 对话窗口（ai-chat，surface `chat`）与桌面角色窗口（renderer，surface `mascot`）各有一个
 * `services/api.ts`，但「这一页走哪条传输」的判定完全相同，过去两边各抄一份。判定拆成三个可独立
 * 摇除的函数，视图在 `createAppClient()` 之前、按优先级各调一次：
 *
 *  1. {@link hasPreloadBridge}：有 preload 桥（`window.nomiTransport`，Electron）就走惰性读桥；
 *  2. {@link installGoHostTransport}：没桥、页面地址片段里有 Go 宿主给的回环 WebSocket 配置
 *     （`resolveHostTransport`，只认 127.0.0.1）时装上，生产构建也要用；
 *  3. {@link installDevTransport}：没桥、开发服务器注入了 `window.nomiDevTransport`（`pnpm dev:web`，
 *     地址在全局、token 在打印的地址片段里）时装上。**视图只能在 `import.meta.env.DEV` 门控里调它**——
 *     生产构建里那个分支与本函数、`resolveDevTransport` 一起被摇掉，产物里不含读开发态 token 的代码。
 */

import { createWebSocketClientTransport, type Surface } from '@nomi-ai/contract';
import {
  NOMI_DEV_TRANSPORT_GLOBAL,
  NOMI_TRANSPORT_GLOBAL,
  resolveDevTransport,
  resolveHostTransport,
  type DevTransportConfig,
} from '@nomi-ai/contract/app';

import { installSharedTransport } from './sharedTransport';

/** 视图窗口的界面（测试界面不由视图传） */
export type ViewSurface = Exclude<Surface, 'test'>;

function currentWindow(): Window | undefined {
  return typeof globalThis !== 'undefined' ? (globalThis as { window?: Window }).window : undefined;
}

/** 读 window 上的 preload 传输桥（只判断在不在，不触发惰性建连）；无 window 时为 false */
export function hasPreloadBridge(): boolean {
  const win = currentWindow();
  return (
    !!win && typeof (win as unknown as Record<string, unknown>)[NOMI_TRANSPORT_GLOBAL] === 'object'
  );
}

/**
 * Go 宿主（`apps/desktop-go`，Wails 没有 preload）：没桥、页面地址片段里有宿主给的回环 WebSocket
 * 地址与本次启动的一次性 token（`resolveHostTransport`，只认 127.0.0.1）时，经 WebSocket 装上共享传输。
 * 命中返回 true；不是 Go 宿主（或无 window）时原样返回 false。
 */
export function installGoHostTransport(surface: ViewSurface): boolean {
  const win = currentWindow();
  if (!win) return false;
  const config = resolveHostTransport(win.location.hash);
  if (!config) return false;
  installSharedTransport(createWebSocketClientTransport({ ...config, surface }));
  return true;
}

/**
 * 开发态 WebSocket 配置：地址来自开发服务器注入的 `window.nomiDevTransport`；token 来自 dev:web
 * 打印的地址里的 `#nomi-token=…` 片段（读到后存 sessionStorage 并从地址栏抹掉），页面 HTML 里没有
 * token。命中时装上共享传输并返回 true。**只应在开发构建（`import.meta.env.DEV`）里调。**
 */
export function installDevTransport(surface: ViewSurface): boolean {
  const win = currentWindow();
  if (!win) return false;
  const config = readDevTransportConfig(win);
  if (!config) return false;
  installSharedTransport(createWebSocketClientTransport({ ...config, surface }));
  return true;
}

function readDevTransportConfig(win: Window): DevTransportConfig | null {
  const storage = ((): Storage | null => {
    try {
      return win.sessionStorage;
    } catch {
      return null;
    }
  })();
  return resolveDevTransport(
    (win as unknown as Record<string, unknown>)[NOMI_DEV_TRANSPORT_GLOBAL],
    {
      hash: win.location.hash,
      storage,
      replaceFragment: (rest) => {
        const { pathname, search } = win.location;
        win.history.replaceState(
          win.history.state,
          '',
          `${pathname}${search}${rest ? `#${rest}` : ''}`,
        );
      },
    },
  );
}

/** 视图记录的三种传输在位标志 */
export interface ViewTransportFlags {
  /** 有 preload 桥（Electron 宿主窗口） */
  hasPreload: boolean;
  /** 跑在 Go 宿主（Wails）里，经回环 WebSocket 连 Go 内核 */
  isGoHost: boolean;
  /** 开发态在普通浏览器里经 WebSocket 连开发态内核（没有桌面窗口） */
  isDev: boolean;
}

/** 有没有可用的契约传输（浏览器预览 / 测试里为 false，调用方据此退回本地状态） */
export function hasTransport(flags: ViewTransportFlags): boolean {
  return flags.hasPreload || flags.isGoHost || flags.isDev;
}

/** 页面上有没有桌面窗口宿主（Electron preload 或 Go 宿主）；浏览器开发页里没有窗口可拖、可穿透 */
export function hasWindowHost(flags: ViewTransportFlags): boolean {
  return flags.hasPreload || flags.isGoHost;
}
