import { t } from '@nomi-ai/ui';

import type { ReasoningEffort } from '../../services/harnessClient';

/** 思考深度档位的显示名（编程助手的档位，以及 Nomi 对话里多出来的开关档） */
export function thinkingLevelLabel(id: string): string {
  if (id === 'off') return t('ui.chat-settings.thinking-off');
  if (id === 'on') return t('ui.chat-settings.thinking-on');
  return effortLabel(id as ReasoningEffort);
}

/** 思考深度档位的显示名 */
export function effortLabel(e: ReasoningEffort): string {
  switch (e) {
    case 'minimal':
      return t('ui.chat-settings.minimal');
    case 'low':
      return t('ui.chat-settings.low');
    case 'medium':
      return t('ui.chat-settings.medium');
    case 'high':
      return t('ui.chat-settings.high');
    case 'xhigh':
      return t('ui.chat-settings.extra-high');
    case 'max':
      return t('ui.chat-settings.max');
    case 'ultra':
      return t('ui.chat-settings.ultra');
  }
}
