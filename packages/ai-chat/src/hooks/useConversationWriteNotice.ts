import { t } from '@nomi-ai/ui';

import { CONVERSATION_WRITE_FAILED_EVENT } from '../services/conversationStore';

import { useWindowEvent } from './useWindowEvent';

/** 对话记录写不进内核（重试用尽 / 被拒收）：提示一次，不打断（存储会接着重试） */
export function useConversationWriteNotice(notify: (message: string) => void): void {
  useWindowEvent(CONVERSATION_WRITE_FAILED_EVENT, () =>
    notify(t('ui.chat-settings.history-save-failed')),
  );
}
