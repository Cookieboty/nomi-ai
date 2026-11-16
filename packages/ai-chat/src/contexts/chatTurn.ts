/**
 * 「一轮对话」所属的会话（从 AiChatContext 拆出）：流式回复要等很久，期间用户可能切换 / 新建会话，
 * 落盘必须写回发起这一轮的会话，界面更新也只在该会话仍在显示时进行。
 */
import type { ChatMessage } from '../types/chat';
import type { IPCClient } from '../types/ipc';

import type { SteerableStream } from './nomiSteer';

/**
 * 固定「一轮对话」所属的会话：流式回复要等很久，期间用户可能切换 / 新建会话，
 * 落盘必须写回发起这一轮的会话，界面更新也只在该会话仍在显示时进行。
 */
export interface ConversationTurn {
  convoId: string | undefined;
  /**
   * 发起时该会话的项目：和 convoId 一起固定，随请求显式带给内核，
   * 不在准备结束后再按「当前会话」重新读取（期间用户可能已切到另一个项目的会话）
   */
  projectId: string | undefined;
  /**
   * 发起这一轮的会话是否仍是当前展示的会话（且仍存在）。
   * 会话被删除后 store 的 current 可能变成 undefined 或另一个会话，二者都不算 active。
   */
  isActive: () => boolean;
  /** 发起这一轮的会话是否还在 store 里（已删除的会话不应再触发摘要 / 记忆写入） */
  exists: () => boolean;
  save: (message: ChatMessage) => Promise<void>;
}

export function openTurn(client: IPCClient): ConversationTurn {
  const convoId = client.ensureConversationId?.() ?? client.currentConversationId?.();
  const meta = convoId ? client.conversationStore?.()?.get(convoId) : undefined;
  return {
    convoId,
    projectId: typeof meta?.projectId === 'string' && meta.projectId ? meta.projectId : undefined,
    // 有 convoId 时必须 cur === convoId：current 为 undefined 说明会话刚被删光，不能当作仍在显示。
    // 只有完全没有会话 id 接口的旧实现（convoId 为空）才走无 id 的兜底。
    isActive: () => !convoId || client.currentConversationId?.() === convoId,
    exists: () =>
      !convoId || !client.conversationStore || !!client.conversationStore()?.get(convoId),
    save: (message) =>
      convoId && client.saveMessageTo
        ? client.saveMessageTo(message, convoId)
        : client.saveMessage(message),
  };
}

/** 按 id 覆盖，不存在则追加（顺序保持：新的追加在末尾） */
export function upsertById(list: ChatMessage[], items: readonly ChatMessage[]): ChatMessage[] {
  let out = list;
  for (const m of items) {
    const i = out.findIndex((x) => x.id === m.id);
    out = i < 0 ? [...out, m] : out.map((x, k) => (k === i ? { ...x, ...m } : x));
  }
  return out;
}

export const newReqId = (): string =>
  `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export interface ActiveStream extends SteerableStream {
  convoId: string | undefined;
}

/** 进行中这一轮的消息快照（用户消息 + 已生成的回复）：一轮结束才落盘 */
export interface InflightTurn {
  reqId: string;
  convoId?: string;
  messages: ChatMessage[];
}
