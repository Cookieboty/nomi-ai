/**
 * 视图窗口的契约传输（docs/design/core-host-decoupling.md §5.2、§11.1）。
 *
 * 对话窗口（ai-chat，surface `chat`）与桌面角色窗口（renderer，surface `mascot`）各有一个
 * `services/api.ts`，在 `createAppClient()` 之前调一次 {@link installGoHostTransport}：
 * Go 宿主（`apps/desktop-go`，Wails）把回环 WebSocket 地址与本次启动的一次性 token 放在页面地址片段里
 * （`resolveHostTransport`，只认 127.0.0.1），读到就装上共享传输。浏览器预览、测试里没有，返回 false，
 * 视图据此退回本地状态。
 */

import { createWebSocketClientTransport, type Surface } from '@nomi-ai/contract';
import { resolveHostTransport } from '@nomi-ai/contract/app';

import { installSharedTransport } from './sharedTransport';

/** 视图窗口的界面（测试界面不由视图传） */
export type ViewSurface = Exclude<Surface, 'test'>;

/**
 * 页面地址片段里有宿主给的回环 WebSocket 配置时，经 WebSocket 装上共享传输并返回 true；
 * 不在 Nomi 窗口里（或无 window）时返回 false。
 */
export function installGoHostTransport(surface: ViewSurface): boolean {
  const win =
    typeof globalThis !== 'undefined' ? (globalThis as { window?: Window }).window : undefined;
  if (!win) return false;
  const config = resolveHostTransport(win.location.hash);
  if (!config) return false;
  installSharedTransport(createWebSocketClientTransport({ ...config, surface }));
  return true;
}
