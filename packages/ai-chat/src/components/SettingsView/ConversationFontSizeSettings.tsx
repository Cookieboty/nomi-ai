import { Select, SettingRow, t } from '@nomi-ai/ui';
import React, { useSyncExternalStore } from 'react';

import {
  CONVERSATION_FONT_SIZES,
  getConversationFontSize,
  setConversationFontSize,
  subscribeConversationFontSize,
} from '../../services/conversationFontSize';

/** 会话正文字号：三档，只写「普通 / 较大 / 特大」，不写像素 */
export function ConversationFontSizeSettings() {
  const size = useSyncExternalStore(subscribeConversationFontSize, getConversationFontSize);
  return (
    <SettingRow
      title={t('ui.chat-settings.conversation-font-size')}
      description={t('ui.chat-settings.conversation-font-size-description')}
    >
      <Select
        size="sm"
        value={String(size)}
        aria-label={t('ui.chat-settings.conversation-font-size')}
        data-testid="conversation-font-size"
        onChange={(e) => setConversationFontSize(Number(e.target.value))}
        options={CONVERSATION_FONT_SIZES.map((o) => ({ value: String(o.size), label: t(o.label) }))}
      />
    </SettingRow>
  );
}
