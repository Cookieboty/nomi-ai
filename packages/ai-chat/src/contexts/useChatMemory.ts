/**
 * 长期记忆：对话消息的定期摘要（从 AiChatContext 拆出）。
 */
import { useCallback, useEffect, type MutableRefObject } from 'react';

import { ingestConversation } from '../services/memClient';
import type { ChatMessage } from '../types/chat';

import type { AiChatState } from './aiChatState';

/**
 * 最新消息的引用（窗口隐藏 / 新建会话时拿来做摘要）。
 * 每积累 10 条消息自动摘要一次。
 */
export function useMemoryIngest(stateRef: MutableRefObject<AiChatState>) {
  const ingestCurrent = useCallback(
    (msgs?: ChatMessage[], convoId?: string) => {
      const s = stateRef.current;
      ingestConversation(
        convoId ?? s.ipcClient.currentConversationId?.(),
        (msgs ?? s.messages)
          .filter((m) => !m.error && !m.stopped)
          .map((m) => ({ role: m.role, content: m.content })),
      );
    },
    [stateRef],
  );

  useEffect(() => {
    // 对话窗口被隐藏 / 关闭 → 把这段对话整理进记忆（主进程会跳过没有新内容的会话）
    const onHide = () => document.visibilityState === 'hidden' && ingestCurrent();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [ingestCurrent]);

  const maybeIngest = useCallback(
    (msgs: ChatMessage[], convoId?: string) => {
      if (msgs.length >= 4 && msgs.length % 10 < 2) ingestCurrent(msgs, convoId);
    },
    [ingestCurrent],
  );

  return { ingestCurrent, maybeIngest };
}
