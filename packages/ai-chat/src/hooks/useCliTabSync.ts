/**
 * 把 harness CLI 标签镜像进 ConversationStore，供侧栏「全部 / 按端」统一渲染。
 */
import { useEffect, useMemo, useRef } from 'react';

import { selectIpcClient, useAiChatSelector } from '../contexts/aiChatStore';
import { useHarnessTabs } from '../contexts/HarnessTabsContext';
import { MAIN_TAB_ID, type HarnessBackend, type HarnessTabMeta } from '../services/harnessClient';
import type { ConversationBackend } from '../types/chat';

function asBackend(b: HarnessBackend): ConversationBackend {
  return b;
}

export function useCliTabSync(onChange?: () => void): void {
  const ipcClient = useAiChatSelector(selectIpcClient);
  const tabs = useHarnessTabs();
  const store = ipcClient.conversationStore?.();
  // activeTabId、status 和 unread 会在切换/运行时频繁变化，但不会改变侧栏元数据。
  // 只用真正影响会话列表的字段生成同步键，避免每次切换都写 localStorage 并刷新列表。
  const cliTabs = useMemo(
    () =>
      (tabs.state?.tabs ?? []).filter((tab) => tab.id !== MAIN_TAB_ID && tab.backend !== 'nomi'),
    [tabs.state],
  );
  const tabListRef = useRef<HarnessTabMeta[]>([]);
  useEffect(() => {
    tabListRef.current = cliTabs;
  }, [cliTabs]);
  const tabsReady = tabs.state !== null;
  // 结构键（增删 / 改名 / 绑定会话）变了立即同步；只有 updatedAt 变（每轮发送 / 结束都会变）时
  // 推迟到空闲再做，不和回合结束时的那次重渲染挤在同一帧（同步会写存储并触发侧栏 IPC 刷新）
  const structKey = cliTabs
    .map(
      (tab) => `${tab.id}:${tab.title}:${tab.backend}:${tab.createdAt}:${tab.cliSessionId ?? ''}`,
    )
    .join('|');
  const timeKey = cliTabs.map((tab) => tab.updatedAt).join('|');
  const syncedStructRef = useRef<string | null>(null);

  useEffect(() => {
    if (!store || !tabsReady) return;
    const sync = () => {
      syncedStructRef.current = structKey;
      syncTabs();
    };
    if (syncedStructRef.current !== structKey) {
      sync();
      return;
    }
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: object) => number })
      .requestIdleCallback;
    const id = ric ? ric(sync, { timeout: 300 }) : window.setTimeout(sync, 50);
    return () => {
      if (ric) (window as { cancelIdleCallback?: (n: number) => void }).cancelIdleCallback?.(id);
      else window.clearTimeout(id);
    };

    function syncTabs() {
      if (!store) return;
      const cli = tabListRef.current;
      const liveIds = new Set(cli.map((t) => t.id));
      for (const t of cli) {
        store.upsertFromTab({
          id: t.id,
          title: t.title,
          backend: asBackend(t.backend),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          cliSessionId: t.cliSessionId ?? undefined,
        });
      }
      // 侧栏里仍挂着已关闭标签的项 → 清掉
      for (const c of store.list()) {
        if (c.tabId && !liveIds.has(c.tabId)) store.removeByTabId(c.tabId);
      }
      onChange?.();
    }
  }, [store, structKey, timeKey, tabsReady, onChange]);
}
