/**
 * 分叉对话：同端复制 / 跨端复制可见文本（CLI 为 seed 转录或 preface，非 resume）。
 */
import { t } from '@nomi-ai/ui';

import type { ChatMessage, ConversationBackend } from '../types/chat';
import { ENDPOINT_FULL, isCliBackend } from '../utils/endpointBadge';
import {
  buildCliContextPreface,
  compactTranscript,
  cutAfter,
  keepLastTurns,
} from '../utils/forkTranscript';

import { notifyConversationsChanged, type ConversationStore } from './conversationStore';
import {
  MAIN_TAB_ID,
  harnessClient,
  type HarnessBackend,
  type HarnessTabMessage,
  type ReasoningEffort,
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
      ...(m.images?.length ? { images: m.images } : {}),
    }));
    return { meta, messages };
  }
  // 没缓存的会话从内核读（不能当成空的去复制）
  return { meta, messages: await store.loadMessages(sourceId) };
}

export interface ForkOptions {
  /** Focus-mode branches keep source/model settings and image attachments. */
  inheritSettings?: boolean;
  /** 副本放进哪个项目；不给 = 沿用源会话的 */
  projectId?: string;
  /** 从这条消息分叉：只带到它为止（消息末尾的「分叉」）；不给 = 带到最后 */
  upto?: string;
  /** 只带最近几轮（undefined = 全部） */
  turns?: number;
}

/** 新会话里要显示 / 带入的消息：整理后再按轮数裁 */
function forkedMessages(
  messages: ChatMessage[],
  turns?: number,
  keepImages = false,
): ChatMessage[] {
  return keepLastTurns(compactTranscript(messages, { keepImages }), turns);
}

function toTabMessages(messages: ChatMessage[]): HarnessTabMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
    timestamp: m.timestamp,
    ...(m.images?.length ? { images: m.images } : {}),
  }));
}

/** 源会话的项目：Nomi 对话看 meta，CLI 会话看它的标签 */
async function sourceProject(meta: {
  projectId?: string;
  tabId?: string;
}): Promise<string | undefined> {
  if (meta.projectId) return meta.projectId;
  if (!meta.tabId) return undefined;
  const st = await harnessClient.tabs().catch(() => null);
  return st?.tabs.find((x) => x.id === meta.tabId)?.projectId;
}

/** 同端分叉：新会话 / 新 CLI 标签，复制可见消息 */
export async function forkSameBackend(
  store: ConversationStore,
  sourceId: string,
  opts: ForkOptions = {},
): Promise<ForkResult> {
  const { meta, messages } = await loadSourceMessages(store, sourceId);
  const title = t('ui.cli-monitor.copy', meta.name);
  const kept = forkedMessages(cutAfter(messages, opts.upto), opts.turns, opts.inheritSettings);

  if (isCliBackend(meta.backend)) {
    // 副本默认沿用源标签的项目
    const source =
      opts.inheritSettings && meta.tabId
        ? (await harnessClient.tabs()).tabs.find((item) => item.id === meta.tabId)
        : undefined;
    if (opts.inheritSettings && !source)
      throw new Error(t('ui.cli-monitor.conversation-not-found'));
    const projectId = opts.projectId ?? source?.projectId ?? (await sourceProject(meta));
    const tab = await harnessClient.createTab({
      backend: meta.backend as Exclude<HarnessBackend, 'nomi'>,
      title,
      messages: toTabMessages(kept),
      ...(projectId ? { projectId } : {}),
      ...(source?.pluginId ? { pluginId: source.pluginId } : {}),
    });
    if (opts.inheritSettings && source && source.backend !== 'external') {
      try {
        const selectedSource = source.source ?? 'official';
        const model = source.modelOverride ?? source.lastServedRef;
        await harnessClient.setTabSource(
          tab.id,
          selectedSource,
          selectedSource === 'thirdParty' ? model : undefined,
        );
        if (selectedSource === 'official') {
          await harnessClient.setTabAccount(tab.id, source.accountId ?? null);
          if (source.modelOverride)
            await harnessClient.setTabModel(tab.id, source.modelOverride, {
              expectSource: 'official',
            });
        }
        if (source.reasoningEffort)
          await harnessClient.setTabEffort(tab.id, source.reasoningEffort as ReasoningEffort);
        if (source.longContext)
          await harnessClient.setTabLongContext(tab.id, source.longContext.on);
      } catch (error) {
        await harnessClient.closeTab(tab.id).catch(() => undefined);
        throw error;
      }
    }
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
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
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
  const compact = forkedMessages(cutAfter(messages, opts.upto), opts.turns);
  // 项目：菜单里选的，否则沿用源会话的
  const projectOf = opts.projectId ?? (await sourceProject(meta));

  if (isCliBackend(target)) {
    let seeded = toTabMessages(compact);
    if (seeded.length === 0 && cutAfter(messages, opts.upto).length > 0) {
      seeded = [
        {
          id: `preface_${Date.now()}`,
          role: 'user',
          content: buildCliContextPreface(cutAfter(messages, opts.upto), meta.name),
          timestamp: Date.now(),
        },
      ];
    }
    const tab = await harnessClient.createTab({
      backend: target as Exclude<HarnessBackend, 'nomi'>,
      title: title.slice(0, 60),
      messages: seeded,
      ...(projectOf ? { projectId: projectOf } : {}),
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

  // 分到 Nomi：项目用菜单里选的，否则沿用源会话的项目
  const forked = store.fork(sourceId, {
    name: title,
    backend: 'nomi',
    messages: compact,
    ...(projectOf ? { projectId: projectOf } : {}),
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
