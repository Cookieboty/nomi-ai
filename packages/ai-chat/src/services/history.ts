/**
 * 把 UI 层的会话消息转换为发送给模型的 messages：
 * - 可选 system prompt 放在最前；
 * - 丢弃空内容 / 失败的消息（例如流式中断留下的空 assistant 气泡）；
 * - 最后追加本轮用户输入。
 * token 预算裁剪由主进程 ChatFacade（ai-sdk `fitMessagesToBudget`）负责。
 */

import { t } from '@nomi-ai/ui';

import type { ChatMessage } from '../types/chat';

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: Array<{ mime: string; data: string }>;
}

export function buildProviderMessages(
  history: readonly ChatMessage[],
  userContent: string,
  systemPrompt?: string,
  images?: Array<{ mime: string; data: string }>,
): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  if (systemPrompt && systemPrompt.trim())
    out.push({ role: 'system', content: systemPrompt.trim() });
  for (const m of history) {
    if (m.error || ((!m.content || !m.content.trim()) && !m.images?.length)) continue;
    // 历史里的图片不再重发（只有缩略图），用文字占位让模型知道上下文
    const tag = m.images?.length
      ? t('ui.chat-settings.images-were-attached-earlier', m.images.length)
      : '';
    out.push({ role: m.role, content: tag + m.content });
  }
  out.push(
    images?.length
      ? { role: 'user', content: userContent, images }
      : { role: 'user', content: userContent },
  );
  return out;
}
