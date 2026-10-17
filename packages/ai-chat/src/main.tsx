import { AIProvider } from '@nomi-ai/ai-sdk-client/react';
import { createLogger, LocaleRoot, initLocale, initTheme } from '@nomi-ai/ui';
import React from 'react';
import ReactDOM from 'react-dom/client';

import '@nomi-ai/ui/styles.css';
import '@nomi-ai/voice/styles.css';
import App from './App';
import { SnipOverlay } from './components/SnipOverlay';

const log = createLogger('main');

// 主题（默认 Warm Ink；设置 → 通用 → 主题）与界面语言（默认跟随系统；设置 → 通用 → 语言）
initTheme();
initLocale();

// 一体化标题栏：主进程用 hiddenInset（mac）/ titleBarOverlay（Win·Linux）创建窗口，
// 页面顶部留出可拖动的标题栏区域（见 App.css .app-titlebar）
{
  const platform = (window as { electronAPI?: { platform?: string } }).electronAPI?.platform;
  if (platform) document.documentElement.dataset.platform = platform;
}

const hasAiIpc = typeof window !== 'undefined' && Boolean((window as { aiIPC?: unknown }).aiIPC);

if (!hasAiIpc) {
  log.warn('当前运行在开发模式：window.aiIPC 未就绪，将使用 Mock 数据');
}

const root = ReactDOM.createRoot(document.getElementById('root')!);

if (window.location.hash === '#snip') {
  // 截图框选遮罩：不加载对话应用本身
  root.render(<LocaleRoot render={() => <SnipOverlay />} />);
} else if (hasAiIpc) {
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
