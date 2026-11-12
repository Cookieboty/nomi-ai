/**
 * 界面形态（React 订阅）：装了编程助手 = dev（显示编程助手相关界面），没装 = normal。
 * 由 services/cliPresence 按本机是否装了 CLI 决定，用户不再手动切换。
 */
import { useSyncExternalStore } from 'react';

import { getChatMode, subscribeChatMode, type ChatMode } from '../services/chatPrefs';

export function useChatMode(): { mode: ChatMode; isDev: boolean; isNormal: boolean } {
  const mode = useSyncExternalStore(subscribeChatMode, getChatMode, () => 'normal' as ChatMode);
  return { mode, isDev: mode === 'dev', isNormal: mode === 'normal' };
}
