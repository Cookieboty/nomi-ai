import { t } from '@nomi-ai/ui';

import type { ConvMessage } from '../types/conversation';

export const CONVERSATION_NAV_DEMO_EVENT = 'nomi:dev-conversation-nav-demo';
export const CONVERSATION_NAV_DEMO_ROUNDS = 50;

/** 只给开发版视觉测试使用：不写入会话存储，刷新页面后消失。 */
export function requestConversationNavDemo(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CONVERSATION_NAV_DEMO_EVENT));
}

export function conversationNavDemoMessages(rounds = CONVERSATION_NAV_DEMO_ROUNDS): ConvMessage[] {
  const prompts = [
    t('ui.chat-settings.conversation-nav-demo-prompt-1'),
    t('ui.chat-settings.conversation-nav-demo-prompt-2'),
    t('ui.chat-settings.conversation-nav-demo-prompt-3'),
    t('ui.chat-settings.conversation-nav-demo-prompt-4'),
    t('ui.chat-settings.conversation-nav-demo-prompt-5'),
    t('ui.chat-settings.conversation-nav-demo-prompt-6'),
    t('ui.chat-settings.conversation-nav-demo-prompt-7'),
    t('ui.chat-settings.conversation-nav-demo-prompt-8'),
  ];
  const now = Date.now();
  return Array.from({ length: rounds }, (_, index) => {
    const prompt = prompts[index % prompts.length];
    return [
      {
        id: `dev-nav-demo-user-${index}`,
        role: 'user' as const,
        text: `${prompt}（第 ${index + 1} 轮）`,
        at: now + index * 2,
      },
      {
        id: `dev-nav-demo-assistant-${index}`,
        role: 'assistant' as const,
        text:
          index === rounds - 1
            ? t('ui.chat-settings.conversation-nav-demo-final')
            : `第 ${index + 1} 轮演示已完成。用于观察长会话导航的阶梯动画与悬停摘要。`,
        at: now + index * 2 + 1,
      },
    ];
  }).flat();
}
