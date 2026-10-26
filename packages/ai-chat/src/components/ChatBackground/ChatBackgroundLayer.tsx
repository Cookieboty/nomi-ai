/** 窗口级背景层，与设置及挂到 body 的弹层共用，不拦截指针。 */
import { currentTheme, type ThemeState } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  chatBgStyle,
  getChatBackground,
  subscribeChatBackground,
  type ChatBackgroundState,
} from '../../services/chatBackground';

export const ChatBackgroundLayer: React.FC = () => {
  const [s, setS] = useState<ChatBackgroundState>(getChatBackground);
  const [theme, setTheme] = useState<ThemeState>(currentTheme);
  const active = theme.pref === 'image';
  useEffect(() => subscribeChatBackground(setS), []);
  useEffect(() => {
    const onTheme = (event: Event) => setTheme((event as CustomEvent<ThemeState>).detail);
    window.addEventListener('cd:theme-changed', onTheme);
    return () => window.removeEventListener('cd:theme-changed', onTheme);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (active) root.dataset.chatBg = 'image';
    else delete root.dataset.chatBg;
    root.style.setProperty('--cd-chat-bg-blur', `${s.blur}px`);
    return () => {
      delete root.dataset.chatBg;
      root.style.removeProperty('--cd-chat-bg-blur');
    };
  }, [active, s.blur]);
  if (!active) return null;
  return createPortal(
    <div
      className="chat-bg-layer"
      data-testid="chat-bg-layer"
      data-mode="image"
      aria-hidden
      style={chatBgStyle({ ...s, mode: 'image' })}
    >
      <div className="chat-bg-image" data-testid="chat-bg-image" />
      <div className="chat-bg-mask" data-testid="chat-bg-mask" />
    </div>,
    document.body,
  );
};
