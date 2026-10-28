import { AIProvider } from '@nomi-ai/ai-sdk-client/react';
import { createLogger, LocaleRoot, initLocale, initTheme, installTitleTooltips } from '@nomi-ai/ui';
import React from 'react';
import ReactDOM from 'react-dom/client';

import '@nomi-ai/ui/styles.css';
import '@nomi-ai/voice/styles.css';
import App from './App';
import { api, hasTransport, installHostBackends } from './services/api';
import { initChatBackground } from './services/chatBackground';
import { dropRetiredPrefs } from './services/chatPrefs';

const log = createLogger('main');

// 主题（默认 Sunset Orange；设置 → 通用 → 主题）、界面语言、聊天主面板背景
// 契约接到共享包（ui / voice）的注入点上：须早于 initTheme / initLocale
installHostBackends();
initTheme();
initLocale();
// 原生 title 悬停提示统一换成自绘提示
installTitleTooltips();
initChatBackground();
dropRetiredPrefs();

// 一体化标题栏：主进程用 hiddenInset（mac）/ titleBarOverlay（Win·Linux）创建窗口，
// 页面顶部留出可拖动的标题栏区域（见 App.css .app-titlebar）
// 平台由宿主经契约给出（异步）；先按 UA 猜一个，避免首帧标题栏布局跳动，拿到后以宿主为准
{
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const guess = /Mac OS X|Macintosh/.test(ua)
    ? 'darwin'
    : /Windows/.test(ua)
      ? 'win32'
      : /Linux/.test(ua)
        ? 'linux'
        : '';
  if (hasTransport()) {
    if (guess) document.documentElement.dataset.platform = guess;
    void api.window.platform().then(
      (platform) => {
        if (platform) document.documentElement.dataset.platform = platform;
      },
      (error: unknown) => log.warn('读取平台失败', error),
    );
  }
}

const hasAiIpc = typeof window !== 'undefined' && Boolean((window as { aiIPC?: unknown }).aiIPC);

if (!hasAiIpc) {
  log.warn('当前运行在开发模式：window.aiIPC 未就绪，将使用 Mock 数据');
}

const root = ReactDOM.createRoot(document.getElementById('root')!);

if (hasAiIpc) {
  root.render(
    <React.StrictMode>
      <LocaleRoot
        render={() => (
          <AIProvider>
            <App />
          </AIProvider>
        )}
      />
    </React.StrictMode>,
  );
} else {
  // 开发/预览模式下不构造 ClientAIClient，避免其在 window.aiIPC 缺失时抛错
  root.render(
    <React.StrictMode>
      <LocaleRoot render={() => <App />} />
    </React.StrictMode>,
  );
}
