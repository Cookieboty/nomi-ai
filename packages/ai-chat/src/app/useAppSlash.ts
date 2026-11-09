/**
 * 斜杠命令的接线：输入 / 弹出命令面板，命令结果以系统卡片显示在会话流里。
 * 当前是哪个端、在哪个目录、属于哪个会话（异步命令的结果回到发起命令的会话，与现在显示哪个标签无关）。
 */
import type { AiChatActions } from '../contexts/AiChatContext';
import type { HarnessTabsCore } from '../contexts/HarnessTabsContext';
import { setProviderEndpoint } from '../services/chatPrefs';
import type { HarnessState } from '../services/harnessClient';
import { nomiScopeKey } from '../slash/nomiScope';
import { useSlashCommands } from '../slash/useSlashCommands';
import type { ConversationBackend } from '../types/chat';
import type { ConvMessage } from '../types/conversation';
import type { IPCClient } from '../types/ipc';

import type { AppPanels } from './useAppPanels';

export function useAppSlash(opts: {
  isDev: boolean;
  tabs: HarnessTabsCore;
  harness: HarnessState | null;
  ipcClient: IPCClient;
  firstMessageId: string | undefined;
  actions: AiChatActions;
  busyHere: boolean;
  /** 主对话正在回复时把消息排进待发列表 */
  enqueue: (text: string) => void;
  cliContextMessages: readonly ConvMessage[];
  nomiMessages: readonly ConvMessage[];
  panels: AppPanels;
}) {
  const { isDev, tabs, harness, ipcClient, actions, busyHere, enqueue, panels } = opts;
  const slashTab = isDev && tabs.isCliTab ? tabs.activeTab : null;
  const backend: ConversationBackend = !isDev
    ? 'nomi'
    : (slashTab?.backend ?? harness?.backend ?? 'nomi');
  const cwd = backend === 'nomi' ? '' : slashTab ? slashTab.cwd : (harness?.cwd ?? '');
  /** Nomi 主对话当前会话的标识（不论眼下显示的是不是它） */
  const nomiScope = nomiScopeKey(ipcClient.conversationStore?.(), opts.firstMessageId);
  const sendNomi = (text: string) => {
    if (busyHere) enqueue(text);
    else void actions.sendStreamMessage(text);
  };
  const slash = useSlashCommands({
    backend,
    cwd,
    scopeKey: slashTab ? slashTab.id : nomiScope,
    messages: slashTab ? opts.cliContextMessages : opts.nomiMessages,
    session:
      backend === 'nomi'
        ? null
        : slashTab
          ? {
              id: slashTab.cliSessionId,
              running: slashTab.status === 'running' || slashTab.status === 'queued',
            }
          : { id: harness?.cliSessionId ?? null, running: !!harness?.busy },
    tabId: slashTab?.id ?? null,
    send: (text) => {
      if (slashTab) void tabs.send(text, undefined, 'queue');
      else sendNomi(text);
    },
    sendTo: async (target, text) => {
      if (target.tabId) {
        // CLI 标签：目标标签已关闭 / 后端或目录被改过（重置）→ false，什么都不发
        const expect = { backend: target.backend, cwd: target.cwd };
        return tabs.sendToTab(target.tabId, text, expect, undefined, 'queue');
      }
      // Nomi 主对话：只有它仍是当前这个会话才发（新建 / 切换过会话则丢弃）
      if (nomiScope !== target.scopeKey) return false;
      sendNomi(text);
      return true;
    },
    tabExists: tabs.hasTab,
    newSession: () => {
      if (slashTab) void tabs.create(slashTab.backend, slashTab.projectId);
      else void actions.newConversation();
    },
    compactNomi: (instructions?: string) => actions.compactConversation(instructions),
    onOpenPlugins: panels.openPlugins,
    onOpenProviders: panels.openProviders,
    onOpenSettings: () => {
      if (backend !== 'nomi') setProviderEndpoint(backend);
      panels.openSettings('coding');
    },
  });
  return { slash, backend, cwd };
}
