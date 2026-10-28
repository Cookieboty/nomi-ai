/**
 * 分叉对话：同端复制 / 跨端复制可见文本（CLI 为 seed 转录或 preface，非 resume）。
 */
import { t } from '@nomi-ai/ui';

import type { ChatMessage, ConversationBackend } from '../types/chat';
import { ENDPOINT_FULL, isCliBackend } from '../utils/endpointBadge';
import { buildCliContextPreface, compactTranscript, keepLastTurns } from '../utils/forkTranscript';

import { notifyConversationsChanged, type ConversationStore } from './conversationStore';
import {
  MAIN_TAB_ID,
  harnessClient,
  type HarnessBackend,
  type HarnessTabMessage,
} from './harnessClient';

export interface ForkResult {
  conversationId: string;
  tabId?: string;
  backend: ConversationBackend;
  title: string;
}

async function loadSourceMessages(
  store: ConversationStore,
  sourceId: string,
): Promise<{ meta: NonNullable<ReturnType<ConversationStore['get']>>; messages: ChatMessage[] }> {
  const meta = store.get(sourceId);
  if (!meta) throw new Error(t('ui.cli-monitor.conversation-not-found'));
  if (meta.tabId) {
    const list = await harnessClient.tabMessages(meta.tabId);
    const messages: ChatMessage[] = list.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.error ? '' : m.content,
      timestamp: m.timestamp,
      ...(m.error ? { error: m.content } : {}),
    }));
    return { meta, messages };
  }
  return { meta, messages: store.getMessages(sourceId) };
}

export interface ForkOptions {
  cwd?: string;
  /** 只带最近几轮（undefined = 全部） */
  turns?: number;
}

/** 新会话里要显示 / 带入的消息：整理后再按轮数裁 */
function forkedMessages(messages: ChatMessage[], turns?: number): ChatMessage[] {
  return keepLastTurns(compactTranscript(messages), turns);
}

function toTabMessages(messages: ChatMessage[]): HarnessTabMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
    timestamp: m.timestamp,
  }));
}

/** 同端分叉：新会话 / 新 CLI 标签，复制可见消息 */
export async function forkSameBackend(
  store: ConversationStore,
  sourceId: string,
  opts: ForkOptions = {},
): Promise<ForkResult> {
  const { meta, messages } = await loadSourceMessages(store, sourceId);
  const title = t('ui.cli-monitor.copy', meta.name);
  const kept = forkedMessages(messages, opts.turns);

  if (isCliBackend(meta.backend)) {
    // 副本默认沿用源标签的工作目录
    let cwd = opts.cwd;
    if (!cwd && meta.tabId) {
      const st = await harnessClient.tabs().catch(() => null);
      cwd = st?.tabs.find((x) => x.id === meta.tabId)?.cwd;
    }
    const tab = await harnessClient.createTab({
      backend: meta.backend as Exclude<HarnessBackend, 'nomi'>,
      title,
      messages: toTabMessages(kept),
      ...(cwd ? { cwd } : {}),
    });
    const created = store.upsertFromTab({
      id: tab.id,
      title: tab.title,
      backend: meta.backend,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
      cliSessionId: tab.cliSessionId ?? undefined,
    });
    store.switchTo(created.id);
    notifyConversationsChanged();
    return {
      conversationId: created.id,
      tabId: tab.id,
      backend: meta.backend,
      title: tab.title,
    };
  }

  const forked = store.fork(sourceId, {
    name: title,
    backend: 'nomi',
    messages: kept,
  });
  if (harnessClient.available()) {
    await harnessClient.activateTab(MAIN_TAB_ID).catch(() => undefined);
    await harnessClient.setBackend('nomi').catch(() => undefined);
  }
  notifyConversationsChanged();
  return {
    conversationId: forked.id,
    backend: 'nomi',
    title: forked.name,
  };
}

/** 跨端分叉：新建目标端会话；CLI 写入 compact 转录（非 resume） */
export async function forkCrossBackend(
  store: ConversationStore,
  sourceId: string,
  target: ConversationBackend,
  opts: ForkOptions = {},
): Promise<ForkResult> {
  const { meta, messages } = await loadSourceMessages(store, sourceId);
  if (target === meta.backend) return forkSameBackend(store, sourceId, opts);
  const title = `${meta.name} → ${ENDPOINT_FULL[target]()}`;
  const compact = forkedMessages(messages, opts.turns);

  if (isCliBackend(target)) {
    let seeded = toTabMessages(compact);
    if (seeded.length === 0 && messages.length > 0) {
      seeded = [
        {
          id: `preface_${Date.now()}`,
          role: 'user',
          content: buildCliContextPreface(messages, meta.name),
          timestamp: Date.now(),
        },
      ];
    }
    const tab = await harnessClient.createTab({
      backend: target as Exclude<HarnessBackend, 'nomi'>,
      title: title.slice(0, 60),
      messages: seeded,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    const created = store.upsertFromTab({
      id: tab.id,
      title: tab.title,
      backend: target,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
      cliSessionId: tab.cliSessionId ?? undefined,
    });
    store.switchTo(created.id);
    notifyConversationsChanged();
    return {
      conversationId: created.id,
      tabId: tab.id,
      backend: target,
      title: tab.title,
    };
  }

  const forked = store.fork(sourceId, {
    name: title,
    backend: 'nomi',
    messages: compact,
  });
  if (harnessClient.available()) {
    await harnessClient.activateTab(MAIN_TAB_ID).catch(() => undefined);
    await harnessClient.setBackend('nomi').catch(() => undefined);
  }
  notifyConversationsChanged();
  return {
    conversationId: forked.id,
    backend: 'nomi',
    title: forked.name,
  };
}
