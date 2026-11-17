/**
 * 「一轮对话」所属的会话（从 AiChatContext 拆出）：流式回复要等很久，期间用户可能切换 / 新建会话，
 * 落盘必须写回发起这一轮的会话，界面更新也只在该会话仍在显示时进行。
 */
import { t } from '@nomi-ai/ui';

import { STEER_TAG } from '../services/history';
import type { ChatMessage } from '../types/chat';
import type { IPCClient } from '../types/ipc';

import { steerMessageId, type DeliveredSteer, type SteerableStream } from './nomiSteer';

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
  /** 把先存的用户消息后面（这一轮的回复前）的内容按 id 写成一条用户消息（同 id 覆盖：不会多一条） */
  saveAfter?: (message: ChatMessage, afterId: string) => Promise<void>;
  /** 按 id 删掉一条（不存在的写错也忽略：删一条不存在的是空操作） */
  remove?: (id: string) => Promise<void>;
  /** 把已经交给这一轮的插入写进会话元信息（正常结束时清掉；中途重启后据此补成用户消息） */
  saveDeliveredSteers?: (
    payload: { reqId: string; afterId: string; items: readonly DeliveredSteer[] } | undefined,
  ) => Promise<void>;
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
    saveAfter:
      convoId && client.saveMessageAfterTo
        ? (message, afterId) => client.saveMessageAfterTo!(message, convoId!, afterId)
        : undefined,
    remove:
      convoId && client.removeMessageFrom
        ? (id) => client.removeMessageFrom!(id, convoId!)
        : undefined,
    saveDeliveredSteers:
      convoId && client.saveDeliveredSteersTo
        ? (payload) =>
            client.saveDeliveredSteersTo!(
              convoId!,
              payload && payload.items.length
                ? { reqId: payload.reqId, afterId: payload.afterId, items: [...payload.items] }
                : undefined,
            )
        : undefined,
  };
}

/**
 * 这一轮里已经交给模型的用户插入（见 nomiSteer.DeliveredSteer）补进对话记录：用户消息发出时就先存了，
 * 插进来的这几条还没进记录。应用在回复结束前又被重启（再更新一次 / 崩溃）时，它们也还在对话里（不再丢）。
 * 按 id 写在上一条用户消息后面（同 id 覆盖），读回时它们仍在一条用户消息后面（withInterruptedReply 照常补卡）。
 * 存不支持（旧实现）时什么都不做：结束时它们照样在回复的轨迹里。
 */
export function deliveredSteerMessage(reqId: string, s: DeliveredSteer): ChatMessage {
  return {
    id: steerMessageId(reqId, s.id),
    role: 'user',
    // 标题取的是分节标记前面的那句（见 services/conversationStore.firstMessageChatName）
    content: `${s.marker ? `${s.marker}\n\n` : ''}${STEER_TAG}\n\n${s.text}`,
    timestamp: Date.now(),
    steer: true,
  };
}

export async function persistDeliveredSteer(
  turn: ConversationTurn,
  reqId: string,
  items: readonly DeliveredSteer[],
  afterId: string,
): Promise<void> {
  // 只写元信息：普通一轮仍是追加（用户消息 / 结束时的回复），不整份 replace，也不在结束时再删消息。
  if (!turn.saveDeliveredSteers) return;
  await turn
    .saveDeliveredSteers(items.length ? { reqId, afterId, items } : undefined)
    .catch(() => undefined);
}

/**
 * 这一轮结束了（正常 / 出错 / 停止）：插入的消息已经在回复的轨迹里（interject，下一次发送由
 * buildProviderMessages 排进上下文）。清掉元信息里那份，免得重启后再补成用户消息、和轨迹重复。
 */
export async function finishDeliveredSteers(turn: ConversationTurn): Promise<void> {
  if (!turn.saveDeliveredSteers) return;
  await turn.saveDeliveredSteers(undefined).catch(() => undefined);
}

/**
 * 重启后把元信息里记下的插入补进历史（按 id 插在 afterId 后面；已有同 id 的不重复）。
 * 调用方再按需把 added 追加写入会话（upsertAfter / saveMessageTo，回复还没落盘时等于追加）。
 */
export function withDeliveredSteers(
  history: ChatMessage[],
  payload: { reqId: string; afterId: string; items: readonly DeliveredSteer[] } | undefined,
): { history: ChatMessage[]; added: ChatMessage[] } {
  if (!payload?.items.length) return { history, added: [] };
  const added: ChatMessage[] = [];
  let out = history;
  let after = payload.afterId;
  for (const s of payload.items) {
    const msg = deliveredSteerMessage(payload.reqId, s);
    if (out.some((m) => m.id === msg.id)) {
      after = msg.id;
      continue;
    }
    const at = after ? out.findIndex((m) => m.id === after) : -1;
    out = at < 0 ? [...out, msg] : [...out.slice(0, at + 1), msg, ...out.slice(at + 1)];
    after = msg.id;
    added.push(msg);
  }
  return { history: out, added };
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
  // 末尾若是中途插入的用户消息，重试仍从这一轮原来的那句开始（插进来的几句跟着走）
  let origin = last;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'user') break;
    if (!m.steer) {
      origin = m;
      break;
    }
  }
  return [
    ...history,
    {
      id: `${INTERRUPTED_REPLY_PREFIX}${origin.id}`,
      role: 'assistant',
      content: '',
      error: t('ui.chat-settings.reply-interrupted-by-restart'),
      timestamp: last.timestamp,
    },
  ];
}

/**
 * 读回的历史里重启后补进记录的插入消息（`steer: true`，正文以「你加入了」标记开头）：
 * - live（这个会话还在回复）：回复里已经有它们（轨迹里的 interject / 正文开头「你加入了」分节）——去掉，
 *   正常结束时另有按 id 删的那一步，这里是读回时的兜底；
 * - 否则真的是上一轮被打断时中断处（重启前）内核收到的：待发列表里存过它、交出去时又作为这一轮的用户消息
 *   拼在回复开头发过一次，同一句话在一次请求里出现了两遍——去掉前面有「你加入了」分节的那条,
 *   只留交出去之后补上的那条（重试从它接着，插入的那句不会丢）。只交出去、还没进回复（分节标记开头）的留着。
 */
export function recoverSteerMessages(history: ChatMessage[], live: boolean): ChatMessage[] {
  // 还在回复：插入已在轨迹里，界面上不要再出一份用户消息（元信息里那份等这一轮结束再清）。
  if (live) return history.filter((m) => !m.steer);
  return history;
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
