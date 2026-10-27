/**
 * 业务窗口导航守卫：
 * - 禁止整页导航到任何非当前文档的地址（SPA 只有 hash 路由变化）；
 * - 新窗口一律拒绝在应用内创建；http(s) 外链改由系统浏览器打开，
 *   file: / javascript: / 自定义协议等全部拒绝。
 *
 * 注意：沙箱浏览器 AgentBrowser 有自己独立的、更严格的白名单守卫，不走这里。
 */

import { type BrowserWindow, shell } from 'electron';

const EXTERNAL_LINK_RE = /^https?:\/\//i;

/** 仅允许同源同文档（仅 hash 不同）的导航。 */
function isSameDocumentNavigation(currentUrl: string, nextUrl: string): boolean {
  if (!currentUrl || !nextUrl) return false;
  return currentUrl.split('#')[0] === nextUrl.split('#')[0];
}

export function installWindowGuards(win: BrowserWindow): void {
  const contents = win.webContents;

  contents.on('will-navigate', (event, targetUrl) => {
    if (isSameDocumentNavigation(contents.getURL(), targetUrl)) return;
    event.preventDefault();
  });

  contents.on('will-redirect', (event, targetUrl) => {
    if (isSameDocumentNavigation(contents.getURL(), targetUrl)) return;
    event.preventDefault();
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_LINK_RE.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}
