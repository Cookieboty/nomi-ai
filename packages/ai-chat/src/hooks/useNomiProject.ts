/**
 * Nomi 对话的项目（存在当前 Nomi 会话上，见 ChatSession.projectId）。
 *
 * - 选了项目：Nomi 的文件工具只能在项目的文件夹里用，命令在主文件夹里启动，委派的编程助手也在这个项目里开工
 *   （内核每轮按 projectId 实时取文件夹、再校验后才生效）；
 * - 还没有会话时显示新会话会用的项目（沿用当前 Nomi 对话的）；第一次选择时新建会话；
 * - 清掉项目 = 回到按已授权文件夹。
 */
import { useCallback, useEffect, useState } from 'react';

import type { AiChatState } from '../contexts/AiChatContext';
import { selectIpcClient, useAiChatSelector } from '../contexts/aiChatStore';
import {
  CONVERSATIONS_CHANGED_EVENT,
  notifyConversationsChanged,
  type ConversationStore,
} from '../services/conversationStore';
import type { IPCClient } from '../types/ipc';

/**
 * 只在切换会话 / 会话建立（第一条消息、条数变化）时变的签名：用来重读会话 meta。
 * 不订阅整份 messages，否则流式生成时每一帧都会让调用方（App 根组件）重渲染。
 */
const selectConversationSignature = (s: AiChatState) =>
  `${s.viewConvoId ?? ''}|${s.messages[0]?.id ?? ''}|${s.messages.length}`;

export interface NomiProject {
  /** 当前 Nomi 会话的项目；没有选时为 undefined */
  projectId: string | undefined;
  /** 当前会话（没有会话时 undefined：第一次选择时新建） */
  conversationId: string | undefined;
  set: (projectId: string) => void;
  clear: () => void;
}

export function useNomiProject(): NomiProject {
  // 没有对话上下文（独立渲染的控件 / 测试）时为空
  const ipc = useAiChatSelector(selectIpcClient) as IPCClient | undefined;
  const signature = useAiChatSelector(selectConversationSignature);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, bump);
  }, []);

  const store = ipc?.conversationStore?.() as ConversationStore | undefined;
  const id = ipc?.currentConversationId?.();
  const meta = id && store?.isNomi(id) ? store.get(id) : undefined;
  // 还没有会话：显示新会话会用的项目
  const projectId = meta ? meta.projectId : id ? undefined : store?.defaultNomiProject();
  // signature / tick 只用来在切换会话、会话列表变化后重新读取
  void signature;
  void tick;

  const write = useCallback(
    (next: string | undefined) => {
      if (!store) return;
      const target = id && store.isNomi(id) ? id : ipc?.ensureConversationId?.();
      if (!target) return;
      store.updateMeta(target, { projectId: next });
      notifyConversationsChanged();
    },
    [store, id, ipc],
  );
  const set = useCallback((next: string) => write(next), [write]);
  const clear = useCallback(() => write(undefined), [write]);

  return { projectId, conversationId: meta?.id, set, clear };
}
