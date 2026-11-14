import { AIProvider } from '@nomi-ai/ai-sdk-client/react';
import { createLogger, LocaleRoot, initLocale, initTheme, installTitleTooltips } from '@nomi-ai/ui';
import React from 'react';
import ReactDOM from 'react-dom/client';

import '@nomi-ai/ui/styles.css';
import '@nomi-ai/voice/styles.css';
import App from './App';
import { BootScreen, type BootScreenState } from './components/BootScreen';
import { api, hasTransport, installHostBackends } from './services/api';
import { initChatBackground } from './services/chatBackground';
import { dropRetiredPrefs } from './services/chatPrefs';
import { prepareConversationStore } from './services/conversationBoot';
import { parseDetachSpec } from './utils/detachedTabs';

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
 * 弹出窗口（?detached=<spec>，见 docs/design/side-tabs-workspace.md）：只画那一个子任务 / 文件。
 * 单独一个 chunk，主窗口不加载。
 */
const detachSpec = parseDetachSpec(window.location.search);
const DetachedApp = React.lazy(() =>
  import('./detached/DetachedApp').then((m) => ({ default: m.DetachedApp })),
);

/**
 * 会话存储在 Go 内核里：渲染 App 前取好索引（会话列表、预览、当前会话），首次运行时把本窗口
 * localStorage 里旧的会话（以及 Electron 旧版抽出来的，#181）导入内核（conversationBoot）。
 * 会话存储在 App 渲染时随 IPC 客户端构造，所以先准备再渲染 App；这期间先画启动画面（不白屏，导入时
 * 显示进度）。读不到对话记录时停在启动画面显示错误与「重试」，不渲染空列表。
 */
function renderBoot(state: BootScreenState, onRetry?: () => void): void {
  root.render(
    <React.StrictMode>
      <LocaleRoot render={() => <BootScreen state={state} {...(onRetry ? { onRetry } : {})} />} />
    </React.StrictMode>,
  );
}

function renderApp(): void {
  root.render(
    <React.StrictMode>
      <LocaleRoot
        render={() => (
          <AIProvider>
            {detachSpec ? (
              <React.Suspense fallback={null}>
                <DetachedApp spec={detachSpec} />
              </React.Suspense>
            ) : (
              <App />
            )}
          </AIProvider>
        )}
      />
    </React.StrictMode>,
  );
}

async function bootConversations(): Promise<void> {
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    storage = undefined;
  }
  const r = await prepareConversationStore({
    api,
    ...(storage ? { storage } : {}),
    fetchLegacy: () => api.migration.chatHistory(),
    onProgress: (p) => renderBoot({ kind: 'migrating', done: p.done, total: p.total }),
  }).catch((error: unknown) => ({ ok: false as const, error }));
  if (r.ok) {
    renderApp();
    return;
  }
  log.warn('准备会话存储失败', r.error);
  const retry = () => {
    renderBoot({ kind: 'failed', retrying: true });
    void bootConversations();
  };
  renderBoot({ kind: 'failed' }, retry);
}

if (hasHost) {
  renderBoot({ kind: 'loading' });
  void bootConversations();
} else {
  // 开发/预览模式下不构造 ClientAIClient，避免其在契约传输缺失时抛错
  root.render(
    <React.StrictMode>
      <LocaleRoot render={() => <App />} />
    </React.StrictMode>,
  );
}
