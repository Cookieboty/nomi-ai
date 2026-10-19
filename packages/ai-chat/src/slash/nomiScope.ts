import type { ConversationStore } from '../services/conversationStore';

/**
 * Nomi 主对话当前会话的斜杠命令作用域（不论眼下显示的是不是它）：用会话存储里真实的 Nomi 会话 id，
 * 停在 CLI 镜像时取最近的 Nomi 会话（只读，不切换导航）。两个空会话不再共用 `nomi:new`（#14）；
 * 没有会话存储（Mock 客户端）时退回首条消息 id。
 */
export function nomiScopeKey(
  store: Pick<ConversationStore, 'currentId' | 'isNomi' | 'lastNomiId'> | undefined,
  firstMessageId: string | undefined,
): string {
  const cur = store?.currentId();
  const id = store ? (cur && store.isNomi(cur) ? cur : store.lastNomiId()) : undefined;
  return `nomi:${id ?? firstMessageId ?? 'new'}`;
}
