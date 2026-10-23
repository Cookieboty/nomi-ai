/** 工作台背景层：铺在 .ai-chat-app 最底层（侧栏、对话、中栏、右栏都透出），不拦截指针。
 *  开启时给 <html> 打 data-chat-bg 并写入三栏模糊变量，各栏据此换成半透明底色 + backdrop 模糊。 */
import React, { useEffect, useState } from 'react';

import {
  chatBgBlurVars,
  chatBgStyle,
  getChatBackground,
  subscribeChatBackground,
  type ChatBackgroundState,
} from '../../services/chatBackground';

export const ChatBackgroundLayer: React.FC = () => {
  const [s, setS] = useState<ChatBackgroundState>(getChatBackground);
  useEffect(() => subscribeChatBackground(setS), []);
  useEffect(() => {
    const root = document.documentElement;
    const vars = chatBgBlurVars(s);
    if (s.mode === 'default') delete root.dataset.chatBg;
    else root.dataset.chatBg = s.mode;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    return () => {
      delete root.dataset.chatBg;
      for (const k of Object.keys(vars)) root.style.removeProperty(k);
    };
  }, [s]);
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
