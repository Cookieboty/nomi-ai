/** 各来源的消息 → 统一会话消息（ConvMessage / ConvLive） */
import type { TabLive } from '../contexts/HarnessTabsContext';
import type { HarnessTabMessage } from '../services/harnessClient';
import type { ChatMessage } from '../types/chat';
import type { ConvLive, ConvMessage } from '../types/conversation';

import { ENDPOINT_NAME } from './endpointBadge';

// 按源消息对象缓存：未变化的消息得到同一个 ConvMessage 引用，视图里的 memo 才不会被整体击穿
const harnessCache = new WeakMap<HarnessTabMessage, ConvMessage>();
const chatCache = new WeakMap<ChatMessage, ConvMessage | null>();

/** agent 标签消息 */
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
    ...(m.role === 'assistant' && m.responseModel ? { responseModel: m.responseModel } : {}),
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
  if (m.role === 'system' || m.hidden) return null;
  const label =
    m.role === 'assistant'
      ? m.runtimeBackend && m.runtimeBackend !== 'api' && m.runtimeBackend !== 'nomi'
        ? ((ENDPOINT_NAME as Record<string, string>)[m.runtimeBackend] ?? m.runtimeBackend)
        : ENDPOINT_NAME.nomi
      : undefined;
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
    ...(label ? { label } : {}),
    ...(m.role === 'assistant' && m.modelId ? { model: m.modelId } : {}),
    ...(m.role === 'assistant' && m.responseModel ? { responseModel: m.responseModel } : {}),
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
    ...(l.notice ? { notice: l.notice } : {}),
  };
}

const isVisibleChat = (m: ChatMessage): boolean => m.role !== 'system' && !m.hidden;

const isStreamingAssistant = (m: ChatMessage): boolean =>
  m.role === 'assistant' && !m.error && !m.stopped && m.durationMs === undefined;

/**
 * 找到正在流式中的主回复索引；跳过已完成的后台委派结果消息（delegate-*），
 * 避免后台消息插在尾部时误判流式尾或导致主回复提前定稿。
 */
function liveTailIndex(list: readonly ChatMessage[], running: boolean): number {
  if (!running) return -1;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!;
    if (m.id.startsWith('delegate-')) continue;
    return isStreamingAssistant(m) ? i : -1;
  }
  return -1;
}

/**
 * The settled (non-system, non-hidden) messages: everything except a streaming assistant tail.
 * Element identity is preserved, so a shallow comparison is stable while a reply streams.
 */
export function settledNomiMessages(
  messages: readonly ChatMessage[],
  running: boolean,
): ChatMessage[] {
  const list = messages.filter(isVisibleChat);
  const idx = liveTailIndex(list, running);
  if (idx < 0) return list;
  if (idx === list.length - 1) return list.slice(0, -1);
  return [...list.slice(0, idx), ...list.slice(idx + 1)];
}

/**
 * 进行中这一轮（流式中的助手尾消息）的轨迹；没在跑 / 没有轨迹时 undefined。
 * 返回原数组引用：轨迹只在有新事件时换数组，选择器订阅它不会因流式正文重算。
 */
export function nomiLiveTrace(
  messages: readonly ChatMessage[],
  running: boolean,
): ChatMessage['trace'] | undefined {
  if (!running) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!isVisibleChat(m) || m.id.startsWith('delegate-')) continue;
    return isStreamingAssistant(m) && m.trace?.length ? m.trace : undefined;
  }
  return undefined;
}

/** The live turn while running (streamed text / trace of the tail), else undefined. */
export function nomiLive(messages: readonly ChatMessage[], running: boolean): ConvLive | undefined {
  if (!running) return undefined;
  const list = messages.filter(isVisibleChat);
  const idx = liveTailIndex(list, running);
  const last = idx >= 0 ? list[idx] : undefined;
  const anchor = idx >= 0 ? idx - 1 : list.length - 1;
  let lastUser: ChatMessage | undefined;
  for (let i = anchor; i >= 0; i--) {
    if (list[i]!.role === 'user') {
      lastUser = list[i];
      break;
    }
  }
  if (!last) return { text: '', startedAt: lastUser?.timestamp ?? Date.now() };
  return {
    text: last.content ?? '',
    ...(last.thinking !== undefined ? { thinking: last.thinking } : {}),
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
    a.thinking === b.thinking &&
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
