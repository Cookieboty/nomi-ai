import { Select, SettingRow, t } from '@nomi-ai/ui';
import React, { useSyncExternalStore } from 'react';

import {
  DEFAULT_CONVERSATION_FONT_SIZE,
  MAX_CONVERSATION_FONT_SIZE,
  MIN_CONVERSATION_FONT_SIZE,
  getConversationFontSize,
  setConversationFontSize,
  subscribeConversationFontSize,
} from '../../services/conversationFontSize';

export function ConversationFontSizeSettings() {
  const size = useSyncExternalStore(subscribeConversationFontSize, getConversationFontSize);
  return (
    <SettingRow
      title={t('ui.chat-settings.conversation-font-size')}
      description={t(
        'ui.chat-settings.conversation-font-size-description',
        DEFAULT_CONVERSATION_FONT_SIZE,
      )}
    >
      <Select
        size="sm"
        value={String(size)}
        aria-label={t('ui.chat-settings.conversation-font-size')}
        data-testid="conversation-font-size"
        onChange={(e) => setConversationFontSize(Number(e.target.value))}
        options={Array.from(
          { length: MAX_CONVERSATION_FONT_SIZE - MIN_CONVERSATION_FONT_SIZE + 1 },
          (_, i) => {
            const value = MIN_CONVERSATION_FONT_SIZE + i;
            return { value: String(value), label: `${value}px` };
          },
        )}
      />
    </SettingRow>
  );
}
