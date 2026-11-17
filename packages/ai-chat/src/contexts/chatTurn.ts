/**
 * 「一轮对话」所属的会话（从 AiChatContext 拆出）：流式回复要等很久，期间用户可能切换 / 新建会话，
 * 落盘必须写回发起这一轮的会话，界面更新也只在该会话仍在显示时进行。
 */
import { t } from '@nomi-ai/ui';

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
  /**
   * save 按消息 id 写入（同 id 再存是覆盖、不会多一条）：这时用户消息一发出就先存，
   * 应用在这一轮中途重启（如更新）也不会丢。旧的 / 无会话 id 的实现只追加，仍在一轮结束时存一次。
   */
  persistsById?: boolean;
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
    persistsById: !!(convoId && client.saveMessageTo),
    save: (message) =>
      convoId && client.saveMessageTo
        ? client.saveMessageTo(message, convoId)
        : client.saveMessage(message),
  };
}

/**
 * 这一轮的用户消息落盘：发出就先存（不等这一轮结束），回复期间应用重启（如更新）时它还在对话里，重开后可重试。
 * 之后内容有变（记忆、委派对象）或中间存了压缩摘要（force：放回摘要之后）时按 id 再存一次；没变不重复写。
 * 不支持按 id 写入的实现（persistsById 为假）只在结束时存一次，和以前一样。
 */
export function userMessageSaver(turn: ConversationTurn, message: ChatMessage) {
  let saved: string | undefined;
  return {
    /** 先存 / 更新先存的那份；失败不挡这一轮（结束时再存） */
    async early(force = false): Promise<void> {
      if (!turn.persistsById) return;
      const snap = JSON.stringify(message);
      if (!force && saved === snap) return;
      saved = snap;
      await turn.save({ ...message }).catch(() => {
        saved = undefined;
      });
    },
    /** 一轮结束：先存的那份已是最新就不再写 */
    async final(): Promise<void> {
      const snap = JSON.stringify(message);
      if (saved === snap) return;
      saved = snap;
      await turn.save(message);
    },
  };
}

/** 重开后补在没回复完的用户消息后面的提示卡（只在界面上，不落盘）的 id 前缀 */
export const INTERRUPTED_REPLY_PREFIX = 'interrupted-';

/**
 * 读回的历史以用户消息结尾、而这个会话眼下并没有在回复：上一轮没回复完应用就重启了（如更新）。
 * 补一张可重试的错误卡（重试 = 从这条用户消息重新发送），不让这条消息看起来被晾在那里。
 */
export function withInterruptedReply(history: ChatMessage[]): ChatMessage[] {
  const last = history[history.length - 1];
  if (!last || last.role !== 'user') return history;
  return [
    ...history,
    {
      id: `${INTERRUPTED_REPLY_PREFIX}${last.id}`,
      role: 'assistant',
      content: '',
      error: t('ui.chat-settings.reply-interrupted-by-restart'),
      timestamp: last.timestamp,
    },
  ];
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

/** 进行中这一轮的消息快照（用户消息 + 已生成的回复）：回复一轮结束才落盘（用户消息发出时就已先存） */
export interface InflightTurn {
  reqId: string;
  convoId?: string;
  messages: ChatMessage[];
}
