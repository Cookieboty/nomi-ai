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
import { runLegacyChatImport } from './services/legacyChatImport';

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

const hasHost = hasTransport();

if (!hasHost) {
  log.warn('当前运行在开发模式：契约传输未就绪，将使用 Mock 数据');
}

const root = ReactDOM.createRoot(document.getElementById('root')!);

/**
 * 旧 Electron 对话（Go 版首启抽出，#181）要在会话存储第一次构造之前并进本窗口的 localStorage：
 * 会话存储在 App 渲染时随 IPC 客户端构造，所以先导入再渲染。导入失败只记日志、照常渲染，下次启动再试
 */
async function importLegacyChats(): Promise<void> {
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return;
  }
  if (!storage) return;
  await runLegacyChatImport({ fetch: () => api.migration.chatHistory(), storage }).catch(
    (error: unknown) => log.warn('导入旧对话失败', error),
  );
}

if (hasHost) {
  void importLegacyChats().finally(() =>
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
    ),
  );
} else {
  // 开发/预览模式下不构造 ClientAIClient，避免其在契约传输缺失时抛错
  root.render(
    <React.StrictMode>
      <LocaleRoot render={() => <App />} />
    </React.StrictMode>,
  );
}
