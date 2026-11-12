import type { IPCClient } from '../types/ipc';

import type { ConversationMeta } from './conversationStore';
import type { HarnessTabsState } from './harnessClient';
import { MAIN_TAB_ID, harnessClient } from './harnessClient';

/** Shared by the sidebar and preview chat: switching never owns or stops a running turn. */
export async function activateConversation(
  meta: ConversationMeta,
  deps: {
    ipc: Pick<IPCClient, 'switchConversation' | 'currentConversationId'>;
    tabs: {
      available: boolean;
      state: HarnessTabsState | null;
      activate: (id: string) => Promise<void>;
    };
    loadHistory: () => Promise<void>;
  },
): Promise<void> {
  const { ipc, tabs, loadHistory } = deps;
  if (meta.backend !== 'nomi' && meta.tabId) {
    const activated = tabs.activate(meta.tabId);
    await ipc.switchConversation(meta.id).catch(() => undefined);
    await activated;
    return;
  }
  const main = tabs.state?.tabs.find((tab) => tab.id === MAIN_TAB_ID);
  const pending: Promise<unknown>[] = [];
  if (tabs.available && tabs.state?.activeTabId !== MAIN_TAB_ID)
    pending.push(tabs.activate(MAIN_TAB_ID));
  if (harnessClient.available() && main?.backend !== 'nomi')
    pending.push(harnessClient.setBackend('nomi').catch(() => undefined));
  if (meta.id !== ipc.currentConversationId?.()) {
    await ipc.switchConversation(meta.id);
    await loadHistory();
  }
  await Promise.all(pending);
}
