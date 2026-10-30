/**
 * Nomi 对话的工作区（存在当前 Nomi 会话上，见 ChatSession.cwd）。
 *
 * - 选了工作区：Nomi 的文件 / 命令工具只能在里面用，委派的编程助手也在里面开工（内核校验后才生效）；
 * - 主标签的目录跟着当前会话的工作区走：内核按 knownDir（标签目录 / 最近列表）认这个目录，
 *   setCwd 同时把它记进最近列表；新的 Nomi 对话默认用主标签当前的目录（默认 文稿/nomi）；
 * - 清掉工作区 = 回到原来的行为（按已授权文件夹）。
 */
import { useCallback, useEffect, useState } from 'react';

import { selectIpcClient, selectMessages, useAiChatSelector } from '../contexts/aiChatStore';
import {
  CONVERSATIONS_CHANGED_EVENT,
  notifyConversationsChanged,
  type ConversationStore,
} from '../services/conversationStore';
import { harnessClient } from '../services/harnessClient';
import type { IPCClient } from '../types/ipc';

export interface NomiWorkspace {
  /** 当前 Nomi 会话的工作区；没有选时为空串 */
  cwd: string;
  /** 当前会话（没有会话时 undefined：第一次选择时新建） */
  conversationId: string | undefined;
  set: (cwd: string) => Promise<void>;
  clear: () => void;
}

/** syncMain：切会话时把主标签目录跟上；只读工作区的地方（右栏）传 false，避免重复 setCwd */
export function useNomiWorkspace(
  mainCwd: string | undefined,
  { syncMain = true }: { syncMain?: boolean } = {},
): NomiWorkspace {
  // 没有对话上下文（独立渲染的控件 / 测试）时为空：只显示默认目录
  const ipc = useAiChatSelector(selectIpcClient) as IPCClient | undefined;
  const messages = useAiChatSelector(selectMessages);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, bump);
  }, []);

  const store = ipc?.conversationStore?.() as ConversationStore | undefined;
  const id = ipc?.currentConversationId?.();
  const meta = id && store?.isNomi(id) ? store.get(id) : undefined;
  // 还没有会话：显示新会话会用的默认工作区（主标签当前的目录）
  const cwd = meta ? (meta.cwd ?? '') : id ? '' : (mainCwd ?? '');
  // messages / tick 只用来在切换会话、会话列表变化后重新读取
  void messages;
  void tick;

  // 切到带工作区的会话：主标签目录跟上（内核据此认这个目录）
  useEffect(() => {
    if (!syncMain || !cwd || !mainCwd || cwd === mainCwd || !harnessClient.available()) return;
    void harnessClient.setCwd(cwd).catch(() => undefined);
  }, [syncMain, cwd, mainCwd]);

  const set = useCallback(
    async (next: string) => {
      if (!store) return;
      const target = id && store.isNomi(id) ? id : ipc?.ensureConversationId?.();
      if (!target) return;
      store.updateMeta(target, { cwd: next });
      notifyConversationsChanged();
      if (harnessClient.available()) await harnessClient.setCwd(next).catch(() => undefined);
    },
    [store, id, ipc],
  );

  const clear = useCallback(() => {
    if (!store) return;
    // 还没有会话：先建一个（它会带上默认工作区），再清掉
    const target = id && store.isNomi(id) ? id : ipc?.ensureConversationId?.();
    if (!target) return;
    store.updateMeta(target, { cwd: undefined });
    notifyConversationsChanged();
  }, [store, id, ipc]);

  return { cwd, conversationId: meta?.id, set, clear };
}
