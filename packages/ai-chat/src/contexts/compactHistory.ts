/**
 * 发送前 / `/compact` 的对话压缩（从 AiChatContext 拆出；services/compaction.ts 是纯函数部分）。
 */
import { createLogger, t } from '@nomi-ai/ui';
import type React from 'react';

import {
  canCompact,
  carriedMemory,
  compactionRequest,
  restoreBlock,
  shouldCompact,
} from '../services/compaction';
import { gatewayClient } from '../services/gatewayClient';
import type { ChatMessage } from '../types/chat';
import type { IPCClient } from '../types/ipc';

import type { AiChatAction, ConversationTurn } from './AiChatContext';

const logger = createLogger('AiChat');

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 摘要模型的预算查不到时（旧主进程）按这个算摘要请求的大小 */
const FALLBACK_SUMMARY_BUDGET = 96_000;

export type CompactResult =
  { next: ChatMessage[]; error?: undefined } | { next: null; error?: string };

/**
 * 上下文压缩（services/compaction.ts）：把最近一次摘要之后的对话总结成摘要，作为一条
 * origin: 'compaction' 的消息存进这一轮的会话。force = `/compact`（不看阈值）。
 * 压缩了返回新的历史（含摘要消息）；不需要 / 不能压缩返回 next: null。
 * 失败只留一条提示（不保存），这一轮照常发送，由内核按预算裁掉最早的历史。
 */
export async function compactHistory(
  client: IPCClient,
  history: ChatMessage[],
  nextContent: string,
  turn: ConversationTurn,
  force: boolean,
  dispatch: React.Dispatch<AiChatAction>,
  /** `/compact` 后面带的说明 */
  instructions?: string,
): Promise<CompactResult> {
  if (!client.summarize) return { next: null };
  const [chatCtx, sumCtx] = await Promise.all([
    gatewayClient.nomiContext('chat'),
    gatewayClient.nomiContext('summary'),
  ]);
  if (force ? !canCompact(history) : !chatCtx || !shouldCompact(history, nextContent, chatCtx))
    return { next: null };
  const pending: ChatMessage = {
    id: `compact-${Date.now().toString(36)}`,
    role: 'assistant',
    origin: 'compaction',
    content: '',
    timestamp: Date.now(),
  };
  if (turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: pending });
  try {
    const budget = (sumCtx ?? chatCtx)?.budget ?? FALLBACK_SUMMARY_BUDGET;
    const raw = await client.summarize(compactionRequest(history, budget, instructions));
    if (!raw) throw new Error(t('ui.chat-settings.the-model-returned-an-empty-summary'));
    // 补回最近的文件 / 计划 / 技能（从工具记录里取，不靠模型记得）
    const restore = restoreBlock(history);
    const summary = restore ? `${raw.trim()}\n\n${restore}` : raw;
    // 压缩前带过的长期记忆跟着摘要走（之后每轮照样带，召回也排除它们），不随压缩丢失
    const memory = carriedMemory(history);
    const done: ChatMessage = {
      ...pending,
      content: summary,
      timestamp: Date.now(),
      ...(memory ? { memory } : {}),
    };
    if (turn.isActive()) dispatch({ type: 'UPSERT_MESSAGES', payload: [done] });
    await turn.save(done);
    return { next: [...history, done] };
  } catch (e) {
    const error = errorMessage(e);
    logger.warn('compaction failed', { error });
    if (turn.isActive()) dispatch({ type: 'UPSERT_MESSAGES', payload: [{ ...pending, error }] });
    return { next: null, error };
  }
}
