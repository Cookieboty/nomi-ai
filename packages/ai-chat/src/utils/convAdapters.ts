/** 各来源的消息 → 统一会话消息（ConvMessage / ConvLive） */
import type { TabLive } from '../contexts/HarnessTabsContext';
import type { HarnessTabMessage } from '../services/harnessClient';
import type { ChatMessage } from '../types/chat';
import type { ConvLive, ConvMessage } from '../types/conversation';

import { ENDPOINT_NAME } from './endpointBadge';

// 按源消息对象缓存：未变化的消息得到同一个 ConvMessage 引用，视图里的 memo 才不会被整体击穿
const harnessCache = new WeakMap<HarnessTabMessage, ConvMessage>();
const chatCache = new WeakMap<ChatMessage, ConvMessage | null>();

/** 编程助手标签消息 */
export function fromHarnessMessage(m: HarnessTabMessage, backend: string): ConvMessage {
  const hit = harnessCache.get(m);
  if (hit) return hit;
  const conv = buildHarness(m, backend);
  harnessCache.set(m, conv);
  return conv;
}

function buildHarness(m: HarnessTabMessage, backend: string): ConvMessage {
  const label = (ENDPOINT_NAME as Record<string, string>)[backend] ?? backend;
  return {
    id: m.id,
    role: m.role,
    text: m.error ? '' : m.content,
    at: m.timestamp,
    ...(m.trace?.length ? { trace: m.trace } : {}),
    ...(m.textBreaks?.length ? { textBreaks: m.textBreaks } : {}),
    ...(m.tools?.length ? { legacyTools: m.tools } : {}),
    ...(m.error ? { error: m.content } : {}),
    ...(m.error && m.geminiTrust ? { geminiTrust: m.geminiTrust } : {}),
    ...(m.stopped ? { stopped: true } : {}),
    ...(m.origin ? { origin: m.origin } : {}),
    ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
    ...(m.usage ? { usage: m.usage } : {}),
    ...(m.role === 'assistant' ? { label } : {}),
    ...(m.role === 'assistant' && m.model ? { model: m.model } : {}),
    raw: m,
  };
}

/** Nomi 对话消息（system 消息不展示） */
export function fromChatMessage(m: ChatMessage): ConvMessage | null {
  if (chatCache.has(m)) return chatCache.get(m)!;
  const conv = buildChat(m);
  chatCache.set(m, conv);
  return conv;
}

function buildChat(m: ChatMessage): ConvMessage | null {
  if (m.role === 'system') return null;
  return {
    id: m.id,
    role: m.role,
    text: m.content ?? '',
    at: m.timestamp,
    ...(m.trace?.length ? { trace: m.trace } : {}),
    ...(m.error ? { error: m.error } : {}),
    ...(m.stopped ? { stopped: true } : {}),
    ...(m.origin ? { origin: m.origin } : {}),
    ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
    ...(m.usage ? { usage: m.usage } : {}),
    ...(m.role === 'assistant' ? { label: ENDPOINT_NAME.nomi } : {}),
    ...(m.role === 'assistant' && m.modelId ? { model: m.modelId } : {}),
    raw: m,
  };
}

export function tabLiveToConv(l: TabLive | undefined): ConvLive | undefined {
  if (!l) return undefined;
  return {
    text: l.text,
    ...(l.trace ? { trace: l.trace } : {}),
    ...(l.textBreaks?.length ? { textBreaks: l.textBreaks } : {}),
    ...(l.startedAt !== undefined ? { startedAt: l.startedAt } : {}),
    ...(l.firstEventAt !== undefined ? { firstEventAt: l.firstEventAt } : {}),
    ...(l.permissions?.length ? { permissions: l.permissions } : {}),
    ...(l.permissionExpired ? { permissionExpired: l.permissionExpired } : {}),
    ...(l.agents ? { agents: l.agents } : {}),
    ...(l.status ? { status: l.status } : {}),
  };
}

/**
 * Nomi 会话：流式中的最后一条助手占位消息拆出来作为「运行中的一轮」，
 * 其余消息正常展示；没有内容的占位在首个 chunk 到达前不渲染（由状态行显示「等待模型响应」）。
 */
/** The streaming assistant tail is still being written (shown as the live turn, not a message). */
function liveTail(list: readonly ChatMessage[], running: boolean): ChatMessage | undefined {
  if (!running) return undefined;
  const last = list[list.length - 1];
  return last?.role === 'assistant' && !last.error && !last.stopped ? last : undefined;
}

/**
 * The settled (non-system) messages: everything except a streaming assistant tail. Element
 * identity is preserved, so a shallow comparison is stable while a reply streams.
 */
export function settledNomiMessages(
  messages: readonly ChatMessage[],
  running: boolean,
): ChatMessage[] {
  const list = messages.filter((m) => m.role !== 'system');
  return liveTail(list, running) ? list.slice(0, -1) : list;
}

/** The live turn while running (streamed text / trace of the tail), else undefined. */
export function nomiLive(messages: readonly ChatMessage[], running: boolean): ConvLive | undefined {
  if (!running) return undefined;
  const list = messages.filter((m) => m.role !== 'system');
  let lastUser: ChatMessage | undefined;
  for (let i = list.length - 1; i >= 0; i--)
    if (list[i]!.role === 'user') {
      lastUser = list[i];
      break;
    }
  const last = liveTail(list, running);
  if (!last) return { text: '', startedAt: lastUser?.timestamp ?? Date.now() };
  return {
    text: last.content ?? '',
    ...(last.trace ? { trace: last.trace } : {}),
    startedAt: lastUser?.timestamp ?? last.timestamp,
    ...(last.content || last.trace?.length ? { firstEventAt: last.timestamp } : {}),
  };
}

/** Same live turn (field-wise; trace by identity). */
export function sameLive(a: ConvLive | undefined, b: ConvLive | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.text === b.text &&
    a.trace === b.trace &&
    a.startedAt === b.startedAt &&
    a.firstEventAt === b.firstEventAt
  );
}

/** Settled messages as conversation rows (empty assistant placeholders dropped). */
export function nomiConvMessages(settled: readonly ChatMessage[]): ConvMessage[] {
  const conv: ConvMessage[] = [];
  for (const m of settled) {
    // 没有内容也没出错的助手占位（流以空结果结束）不渲染
    if (m.role === 'assistant' && !m.error && !m.stopped && !m.content?.trim() && !m.trace?.length)
      continue;
    const c = fromChatMessage(m);
    if (c) conv.push(c);
  }
  return conv;
}

export function splitNomiMessages(
  messages: readonly ChatMessage[],
  running: boolean,
): { messages: ConvMessage[]; live?: ConvLive } {
  const live = nomiLive(messages, running);
  const conv = nomiConvMessages(settledNomiMessages(messages, running));
  return { messages: conv, ...(live ? { live } : {}) };
}
