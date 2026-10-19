/** 对话主面板背景层：盖在 .chat-container 底层，不拦截指针。 */
import React, { useEffect, useState } from 'react';

import {
  chatBgStyle,
  getChatBackground,
  subscribeChatBackground,
  type ChatBackgroundState,
} from '../../services/chatBackground';

export const ChatBackgroundLayer: React.FC = () => {
  const [s, setS] = useState<ChatBackgroundState>(getChatBackground);
  useEffect(() => subscribeChatBackground(setS), []);
  if (s.mode === 'default') return null;
  return (
    <div
      className="chat-bg-layer"
      data-testid="chat-bg-layer"
      data-mode={s.mode}
      aria-hidden
      style={chatBgStyle(s)}
    />
  );
};
