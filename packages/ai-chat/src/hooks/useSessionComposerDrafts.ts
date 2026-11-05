/**
 * 输入框草稿按会话隔离（从 App.tsx 拆出）：
 * - 空会话共用 SHARED_UNSENT；发出过消息后按 nomi:<会话 id> / tab:<标签 id> 各存一份（从不按 cwd）；
 * - 会话 / 标签删除后丢掉它的私有草稿，避免复活旧内容。
 * 草稿 Map 挂在调用方（AiChatContent，在 keepalive 之上）：开设置只隐藏不卸载，草稿不丢。
 */
import { useEffect, useMemo, useState } from 'react';

import {
  selectFirstMessageId,
  selectIpcClient,
  selectMessageCount,
  useAiChatSelector,
} from '../contexts/aiChatStore';
import { useHarnessTabsCore } from '../contexts/HarnessTabsContext';
import {
  createComposerDraftStore,
  draftKey,
  sessionHasCommittedUserContent,
} from '../services/composerDrafts';
import {
  CONVERSATIONS_CHANGED_EVENT,
  type ConversationsChangedDetail,
} from '../services/conversationStore';

export function useSessionComposerDrafts() {
  const ipcClient = useAiChatSelector(selectIpcClient);
  const firstMessageId = useAiChatSelector(selectFirstMessageId);
  const messageCount = useAiChatSelector(selectMessageCount);
  const tabs = useHarnessTabsCore();
  const [draftStore] = useState(createComposerDraftStore);

  const activeKey = useMemo(() => {
    if (tabs.isCliTab && tabs.activeTab) {
      const tab = tabs.activeTab;
      // tabs.messages = active CLI tab cache; do not use cliSessionId (late / never on fail)
      return draftKey({
        kind: 'tab',
        id: tab.id,
        hasCommittedUserContent: sessionHasCommittedUserContent(
          tabs.messages?.length ?? 0,
          tab.carriedMessages ?? 0,
        ),
      });
    }
    const id = ipcClient.currentConversationId?.() ?? '';
    // 没加载的会话看内核给的条数（不读消息）
    const store = ipcClient.conversationStore?.();
    const stored = id
      ? typeof store?.hasMessages === 'function'
        ? !!store.hasMessages(id)
        : (store?.getMessages(id)?.length ?? 0) > 0
      : false;
    const has = stored || messageCount > 0;
    return draftKey({
      kind: 'nomi',
      id: id || 'pending',
      hasCommittedUserContent: has && !!id,
    });
    // 当前会话 id 不是响应式的：firstMessageId / activeTabId 变了（换会话、换标签）就重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tabs.isCliTab,
    tabs.activeTab,
    tabs.messages,
    ipcClient,
    messageCount,
    firstMessageId,
    tabs.activeTabId,
  ]);

  // 会话 / 标签删除后丢掉私有草稿桶，避免复活脏数据
  useEffect(() => {
    type Entry = { id: string; tabId?: string };
    const toEntry = (c: { id: string; tabId?: string }): Entry => ({
      id: c.id,
      tabId: c.tabId,
    });
    const dropGone = (gone: Entry) => {
      draftStore.dropPrivate(`nomi:${gone.id}`);
      if (gone.tabId) draftStore.dropPrivate(`tab:${gone.tabId}`);
    };
    let prev: Entry[] = (ipcClient.conversationStore?.()?.list() ?? []).map(toEntry);
    const sync = (ev: Event) => {
      const explicit = (ev as CustomEvent<ConversationsChangedDetail>).detail?.removed;
      if (explicit) for (const gone of explicit) dropGone(gone);
      const list = ipcClient.conversationStore?.()?.list() ?? [];
      const next: Entry[] = list.map(toEntry);
      const nextIds = new Set(next.map((e: Entry) => e.id));
      for (const gone of prev) {
        if (nextIds.has(gone.id)) continue;
        dropGone(gone);
      }
      prev = next;
    };
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, sync);
  }, [ipcClient, draftStore]);

  return { draftStore, draftKey: activeKey };
}
