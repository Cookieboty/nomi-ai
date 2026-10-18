/**
 * 把 harness CLI 标签镜像进 ConversationStore，供侧栏「全部 / 按端」统一渲染。
 */
import { useEffect, useRef } from 'react';

import { useAiChat } from '../contexts/AiChatContext';
import { useHarnessTabs } from '../contexts/HarnessTabsContext';
import { MAIN_TAB_ID, type HarnessBackend } from '../services/harnessClient';
import type { ConversationBackend } from '../types/chat';

function asBackend(b: HarnessBackend): ConversationBackend {
  return b;
}

export function useCliTabSync(onChange?: () => void): void {
  const { state } = useAiChat();
  const tabs = useHarnessTabs();
  const store = state.ipcClient.conversationStore?.();
  // activeTabId、status 和 unread 会在切换/运行时频繁变化，但不会改变侧栏元数据。
  // 只用真正影响会话列表的字段生成同步键，避免每次切换都写 localStorage 并刷新列表。
  const tabListRef = useRef(tabs.state?.tabs ?? []);
  tabListRef.current = tabs.state?.tabs ?? [];
  const tabsReady = tabs.state !== null;
  const syncKey = tabListRef.current
    .filter((tab) => tab.id !== MAIN_TAB_ID && tab.backend !== 'nomi')
    .map(
      (tab) =>
        `${tab.id}:${tab.title}:${tab.backend}:${tab.createdAt}:${tab.updatedAt}:${tab.cliSessionId ?? ''}`,
    )
    .join('|');

  useEffect(() => {
    if (!store || !tabsReady) return;
    const cli = tabListRef.current.filter((t) => t.id !== MAIN_TAB_ID && t.backend !== 'nomi');
    const liveIds = new Set(cli.map((t) => t.id));
    for (const t of cli) {
      store.upsertFromTab({
        id: t.id,
        title: t.title,
        backend: asBackend(t.backend),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      });
    }
    // 侧栏里仍挂着已关闭标签的项 → 清掉
    for (const c of store.list()) {
      if (c.tabId && !liveIds.has(c.tabId)) store.removeByTabId(c.tabId);
    }
    onChange?.();
  }, [store, syncKey, tabsReady, onChange]);
}
