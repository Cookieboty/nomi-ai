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
    ...(m.tools?.length ? { legacyTools: m.tools } : {}),
    ...(m.error ? { error: m.content } : {}),
    ...(m.stopped ? { stopped: true } : {}),
    ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
    ...(m.usage ? { usage: m.usage } : {}),
    ...(m.role === 'assistant' ? { label } : {}),
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
    ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
    ...(m.usage ? { usage: m.usage } : {}),
    ...(m.role === 'assistant' && m.modelId ? { label: m.modelId } : {}),
    raw: m,
  };
}

export function tabLiveToConv(l: TabLive | undefined): ConvLive | undefined {
  if (!l) return undefined;
  return {
    text: l.text,
    ...(l.trace ? { trace: l.trace } : {}),
    ...(l.startedAt !== undefined ? { startedAt: l.startedAt } : {}),
    ...(l.firstEventAt !== undefined ? { firstEventAt: l.firstEventAt } : {}),
    ...(l.permission ? { permission: l.permission } : {}),
    ...(l.status ? { status: l.status } : {}),
  };
}

/**
 * Nomi 会话：流式中的最后一条助手占位消息拆出来作为「运行中的一轮」，
 * 其余消息正常展示；没有内容的占位在首个 chunk 到达前不渲染（由状态行显示「等待模型响应」）。
 */
export function splitNomiMessages(
  messages: readonly ChatMessage[],
  running: boolean,
): { messages: ConvMessage[]; live?: ConvLive } {
  const list = messages.filter((m) => m.role !== 'system');
  const last = list[list.length - 1];
  let live: ConvLive | undefined;
  let rest = list;
  if (running) {
    const lastUser = [...list].reverse().find((m) => m.role === 'user');
    if (last?.role === 'assistant' && !last.error && !last.stopped) {
      rest = list.slice(0, -1);
      live = {
        text: last.content ?? '',
        ...(last.trace ? { trace: last.trace } : {}),
        startedAt: lastUser?.timestamp ?? last.timestamp,
        ...(last.content || last.trace?.length ? { firstEventAt: last.timestamp } : {}),
      };
    } else {
      live = { text: '', startedAt: lastUser?.timestamp ?? Date.now() };
    }
  }
  const conv: ConvMessage[] = [];
  for (const m of rest) {
    // 没有内容也没出错的助手占位（流以空结果结束）不渲染
    if (m.role === 'assistant' && !m.error && !m.stopped && !m.content?.trim() && !m.trace?.length)
      continue;
    const c = fromChatMessage(m);
    if (c) conv.push(c);
  }
  return { messages: conv, ...(live ? { live } : {}) };
}
