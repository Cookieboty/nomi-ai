import React from 'react';

import { ConversationView } from '../src/components/Conversation';
import { nomiSlots } from '../src/components/Conversation/nomiSlots';
import type { ChatMessage } from '../src/types/chat';
import { splitNomiMessages } from '../src/utils/convAdapters';

/** Nomi 对话 → 统一会话视图（与 App 里的接线一致） */
export const NomiConversation: React.FC<{
  messages: ChatMessage[];
  running?: boolean;
  scopeId?: string;
  onStop?: () => void;
  onRetry?: (id: string) => void;
  onEdit?: (id: string, text: string) => void;
}> = ({ messages, running = false, scopeId = 'nomi', ...rest }) => {
  const conv = splitNomiMessages(messages, running);
  return (
    <ConversationView
      scopeId={scopeId}
      messages={conv.messages}
      live={conv.live}
      phase={running ? 'running' : 'idle'}
      slots={nomiSlots}
      {...rest}
    />
  );
};
