import { LocaleRoot, initLocale, initTheme, installTitleTooltips } from '@nomi-ai/ui';
import React from 'react';
import ReactDOM from 'react-dom/client';

import '@nomi-ai/ui/styles.css';
import '@nomi-ai/voice/styles.css';

import { WaifuAIRoot } from './ai';
import App from './App';
import { initMascotPresence } from './mascot/presence';

// 主题与界面语言（设置 → 通用）
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
      <WaifuAIRoot>
        <App />
      </WaifuAIRoot>
    )}
  />,
);
