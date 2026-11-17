import type { IPCClient } from '../types/ipc';

import { getSmartTitle } from './chatPrefs';
import { firstMessageChatName, notifyConversationsChanged } from './conversationStore';
import { splitFileAttachments } from './fileAttachments';
import {
  applyNomiSmartTitle,
  armNomiAutoTitle,
  generateSmartTitle,
  isDefaultChatName,
  nomiAutoTitlePending,
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
