import { t } from '@nomi-ai/ui';

import type { ReasoningEffort } from '../../services/harnessClient';

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
