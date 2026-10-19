// TTS 配置窗口：页面逻辑在 ./page（模块脚本，满足严格 CSP），样式统一到 @nomi-ai/ui 设计令牌（暗色主题）
import '@nomi-ai/ui/styles.css';
import './tts-config.css';

import { initLocale } from '@nomi-ai/ui';

import { refreshTtsConfigText } from './page';
import { applyStaticText } from './staticText';

// 跟随应用语言（经 preload 的 aiIPC 读取 ai:locale:*）；首屏文案由 page 初始化时写入，
// 切换语言时重新写入静态文案并重渲染动态状态（#48）
initLocale();
window.addEventListener('cd:locale-changed', () => {
  applyStaticText(document, true);
  refreshTtsConfigText();
});
