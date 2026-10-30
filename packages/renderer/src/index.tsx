import { LocaleRoot, initLocale, initTheme, installTitleTooltips } from '@nomi-ai/ui';
import React from 'react';
import ReactDOM from 'react-dom/client';

import '@nomi-ai/ui/styles.css';
import '@nomi-ai/voice/styles.css';

import { CompanionAIRoot } from './ai';
import App from './App';
import { initMascotPresence } from './mascot/presence';
import { installHostBackends, isGoHost } from './services/api';

// 主题与界面语言（设置 → 通用）
// 契约接到共享包（ui / voice）的注入点上：须早于 initTheme / initLocale
installHostBackends();
initTheme();
initLocale();
// 原生 title 悬停提示统一换成自绘提示
installTitleTooltips();
// 看板娘被关闭时不朗读
initMascotPresence();

// 创建根元素
const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

// 渲染应用
root.render(
  <LocaleRoot
    render={() => (
      <CompanionAIRoot>
        <App />
      </CompanionAIRoot>
    )}
  />,
);

// Go 宿主：首帧后通知宿主显示窗口（= Electron ready-to-show；Wails mac 默认要等 load 完才显示，见 docs D-B11-17）
if (isGoHost()) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const w = window as unknown as {
        webkit?: { messageHandlers?: { external?: { postMessage(m: string): void } } };
        chrome?: { webview?: { postMessage(m: string): void } };
      };
      try {
        (w.webkit?.messageHandlers?.external ?? w.chrome?.webview)?.postMessage('nomi:first-paint');
      } catch {
        /* 宿主没有消息通道：按页面加载完显示 */
      }
    }),
  );
}
