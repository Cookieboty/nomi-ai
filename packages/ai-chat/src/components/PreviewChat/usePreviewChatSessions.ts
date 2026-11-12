import { t } from '@nomi-ai/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  selectIpcClient,
  selectMessageCount,
  useAiChatActions,
  useAiChatSelector,
} from '../../contexts/aiChatStore';
import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import type { ResourceScope } from '../../contexts/ResourceContext';
import { useChatMode } from '../../hooks/useChatMode';
import { activateConversation } from '../../services/activateConversation';
import {
  CONVERSATIONS_CHANGED_EVENT,
  notifyConversationsChanged,
  type ConversationMeta,
  type ConversationStore,
} from '../../services/conversationStore';
import { forkSameBackend } from '../../services/forkConversation';
import { MAIN_TAB_ID, harnessClient, isNomiDelegated } from '../../services/harnessClient';
import { projectById, useProjects } from '../../services/projects';
import { workspaceKey } from '../../utils/workspacePath';

export function usePreviewChatSessions(
  active: boolean,
  onSelected: (scope: ResourceScope) => void,
  workspaceCwd: string | null | undefined,
) {
  useProjects();
  const ipc = useAiChatSelector(selectIpcClient);
  const viewId = useAiChatSelector((state) => state.viewConvoId);
  const count = useAiChatSelector(selectMessageCount);
  const { actions } = useAiChatActions();
  const tabs = useHarnessTabs();
  const { isDev } = useChatMode();
  const [list, setList] = useState<ConversationMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const generation = useRef(0);
  const store = ipc.conversationStore?.() as ConversationStore | undefined;
  const refresh = useCallback(() => {
    if (!active) return;
    const version = ++generation.current;
    void ipc
      .listConversations?.()
      .then((items) => {
        if (version === generation.current)
          setList(
            items.filter((item) => !item.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt),
          );
      })
      .catch(() => undefined);
    return () => {
      if (version === generation.current) generation.current++;
    };
  }, [ipc, active]);
  useEffect(refresh, [refresh, count, viewId, tabs.activeTabId]);
  useEffect(() => {
    if (!active) return;
    const changed = () => {
      refresh();
    };
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, changed);
  }, [active, refresh]);
  const tabById = new Map(tabs.state?.tabs.map((tab) => [tab.id, tab]));
  const available = list
    .filter(
      (item) =>
        !item.tabId || (tabById.has(item.tabId) && !isNomiDelegated(tabById.get(item.tabId)!)),
    )
    .map((item) => ({
      ...item,
      name: (item.tabId && tabById.get(item.tabId)?.title) || item.name,
    }));
  const sameWorkspace = (item: ConversationMeta) => {
    const cwd = (
      item.tabId ? tabById.get(item.tabId)?.cwd : projectById(item.projectId)?.primary
    )?.trim();
    const origin = workspaceCwd?.trim();
    return cwd && origin ? workspaceKey(cwd) === workspaceKey(origin) : !cwd && !origin;
  };
  const sessions = available.filter(sameWorkspace);
  const current =
    isDev && tabs.isCliTab
      ? available.find((item) => item.tabId === tabs.activeTabId)
      : available.find(
          (item) =>
            item.id === (viewId ?? ipc.currentConversationId?.()) && item.backend === 'nomi',
        );
  const title =
    (isDev && tabs.isCliTab ? tabs.activeTab?.title : current?.name) ||
    t('ui.chat-settings.new-chat');
  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
      refresh();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const choose = (meta: ConversationMeta) =>
    run(async () => {
      if (!sameWorkspace(meta)) throw new Error(t('ui.cli-monitor.conversation-not-found'));
      await activateConversation(meta, {
        ipc,
        tabs,
        loadHistory: actions.loadChatHistory,
      });
      const tab = meta.tabId ? tabById.get(meta.tabId) : undefined;
      onSelected({
        id: tab ? `cli:${tab.id}` : `nomi:${meta.id}`,
        cwd: tab?.cwd ?? projectById(meta.projectId)?.primary ?? null,
        source: meta.backend,
      });
      notifyConversationsChanged();
    });
  const fork = () =>
    run(async () => {
      const source = current && sameWorkspace(current) ? current.id : undefined;
      if (!store || !source) throw new Error(t('ui.cli-monitor.conversation-not-found'));
      const result = await forkSameBackend(store, source, { inheritSettings: true });
      if (result.tabId) {
        await tabs.activate(result.tabId);
      } else {
        if (tabs.available) await tabs.activate(MAIN_TAB_ID);
        await actions.loadChatHistory();
      }
      const created = result.tabId
        ? await harnessClient
            .tabs()
            .then((state) => state.tabs.find((tab) => tab.id === result.tabId))
        : undefined;
      onSelected({
        id: result.tabId ? `cli:${result.tabId}` : `nomi:${result.conversationId}`,
        cwd:
          created?.cwd ?? projectById(store.get(result.conversationId)?.projectId)?.primary ?? null,
        source: result.backend,
      });
      notifyConversationsChanged();
    });
  return {
    sessions,
    currentId: current?.id,
    title,
    busy,
    error,
    choose,
    fork,
    canFork: !!store && !!current && sameWorkspace(current),
  };
}
