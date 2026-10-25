/** `/agent 名字` 指定的「下一个需求交给谁」（按会话；发送后自动清除） */
import { useSyncExternalStore } from 'react';

import { selectIpcClient, useAiChatSelector } from '../contexts/aiChatStore';
import {
  bindNextDelegateConversation,
  getNextDelegate,
  subscribeNextDelegate,
  type DelegateCli,
} from '../services/delegateClient';

export function useNextDelegate(): DelegateCli | null {
  const ipc = useAiChatSelector(selectIpcClient);
  // 渲染时对齐当前会话，切换对话后 chip 显示该会话自己的钉住
  bindNextDelegateConversation(ipc?.currentConversationId?.());
  return useSyncExternalStore(subscribeNextDelegate, getNextDelegate, () => null);
}
