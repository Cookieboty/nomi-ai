import type { IPCClient } from '../types/ipc';

import { api, hasTransport } from './api';
import { getSmartTitle } from './chatPrefs';
import { cliTitleComplete } from './cliSmartTitle';
import { firstMessageChatName, notifyConversationsChanged } from './conversationStore';
import { splitFileAttachments } from './fileAttachments';
import { updateManagedConversationMeta, type ManagedRuntimeState } from './managedMainChat';
import { splitRef } from './nomiModel';
import {
  applyNomiSmartTitle,
  armNomiAutoTitle,
  clearNomiAutoTitle,
  generateSmartTitle,
  isDefaultChatName,
  nomiAutoTitlePending,
  type TitleComplete,
} from './sessionTitle';

/**
 * 首条用户消息发出后：若仍是默认名则后台用当前 chat 模型生成标题（失败保留启发式）。
 * 不等这一轮回复结束就发起，标题和回复并行出（之前只在轮末调，长任务会一直显示「新对话」）。
 * 同一会话正在生成时不重复发；轮末再调一次就是失败重试（名字仍是默认名才会走到模型）。
 */
export function maybeStartNomiSmartTitle(
  client: IPCClient,
  convoId: string | undefined,
  content: string,
): void {
  // 设置里关掉了：用第一句话作标题（conversationStore 落盘时起），不再额外请求模型
  if (!convoId || !client.completeChatText || !getSmartTitle()) return;
  const store = client.conversationStore?.();
  const meta = store?.get(convoId);
  const text = splitFileAttachments(content).text.trim();
  // 用户消息发出时就先存了（会话名先取了这句话）：名字还是这句话本身，也算没起过名
  const autoNamed = meta?.name === firstMessageChatName(content);
  if (!text || !meta || !(isDefaultChatName(meta.name) || autoNamed)) return;
  if (nomiAutoTitlePending(convoId)) return;
  armNomiAutoTitle(convoId);
  const complete = client.completeChatText.bind(client);
  void generateSmartTitle(text, (messages) => complete(messages)).then((title) => {
    const store = client.conversationStore?.();
    applyNomiSmartTitle(convoId, title, {
      get: (id) => store?.get(id),
      updateMeta: (id, patch) => {
        store?.updateMeta(id, patch);
      },
      notify: notifyConversationsChanged,
    });
  });
}

type ManagedSmartTitleStore = {
  get(id: string): { name: string } | undefined;
  refreshManaged?(id: string): Promise<void>;
};

export type ManagedSmartTitleDeps = {
  enabled?: () => boolean;
  getRuntimeState?: (
    id: string,
  ) => Promise<Pick<ManagedRuntimeState, 'backend' | 'source' | 'model'>>;
  cliComplete?: (ref: string) => TitleComplete;
  updateMeta?: (id: string, patch: { name: string; autoTitle: true }) => Promise<void>;
  notify?: () => void;
};

/**
 * 托管对话首轮发送后（名字仍是默认名或首句截取时）：
 * - `api` 底座复用当前 Nomi chat 模型；
 * - 第三方模型 CLI（`thirdParty`）复用其 `provider/model`；
 * - 本地/官方 CLI 订阅底座不额外发 API 请求，交由 CLI 原生标题或磁盘历史回流处理。
 */
export function maybeStartManagedSmartTitle(
  client: IPCClient,
  convoId: string | undefined,
  content: string,
  deps?: ManagedSmartTitleDeps,
): Promise<void> {
  const enabled = deps?.enabled ?? getSmartTitle;
  if (!convoId || !enabled()) return Promise.resolve();
  if (!deps?.getRuntimeState && !hasTransport()) return Promise.resolve();
  const store = client.conversationStore?.() as ManagedSmartTitleStore | undefined;
  const meta = store?.get(convoId);
  const text = splitFileAttachments(content).text.trim();
  const autoNamed = meta?.name === firstMessageChatName(content);
  if (!text || !meta || !(isDefaultChatName(meta.name) || autoNamed)) return Promise.resolve();
  if (nomiAutoTitlePending(convoId)) return Promise.resolve();
  armNomiAutoTitle(convoId);

  return (async () => {
    try {
      const getRuntimeState =
        deps?.getRuntimeState ?? ((id: string) => api.conversations.runtimeState({ id }));
      const state = await getRuntimeState(convoId);
      if (!state || !nomiAutoTitlePending(convoId)) return;

      let complete: TitleComplete | undefined;
      if (state.backend === 'api') {
        if (!client.completeChatText) return;
        complete = client.completeChatText.bind(client);
      } else if (state.source === 'thirdParty' && state.model && splitRef(state.model)) {
        complete = (deps?.cliComplete ?? cliTitleComplete)(state.model);
      } else {
        return;
      }

      const title = await generateSmartTitle(text, complete);
      if (!title || !nomiAutoTitlePending(convoId)) return;
      const latestStore = client.conversationStore?.() as ManagedSmartTitleStore | undefined;
      if (!latestStore?.get(convoId)) return;

      const updateMeta =
        deps?.updateMeta ??
        ((id: string, patch: { name: string; autoTitle: true }) =>
          updateManagedConversationMeta(api, id, patch));
      await updateMeta(convoId, { name: title, autoTitle: true });
      await latestStore.refreshManaged?.(convoId);
      (deps?.notify ?? notifyConversationsChanged)();
    } catch {
      // 智能标题失败保留内核/CLI 侧标题，不影响主对话
    } finally {
      clearNomiAutoTitle(convoId);
    }
  })();
}
