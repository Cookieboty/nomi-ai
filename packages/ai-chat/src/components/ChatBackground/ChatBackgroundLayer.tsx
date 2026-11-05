/** 窗口级背景层，与设置及挂到 body 的弹层共用，不拦截指针。
 *  底图保持清晰且尺寸固定，上方单层蒙版采样模糊并调节遮罩不透明度。 */
import { currentTheme } from '@nomi-ai/ui';
import React, { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import {
  chatBgStyle,
  getChatBackground,
  revalidateChatBackground,
  subscribeChatBackground,
} from '../../services/chatBackground';

const subscribeTheme = (fn: () => void) => {
  window.addEventListener('cd:theme-changed', fn);
  return () => window.removeEventListener('cd:theme-changed', fn);
};

export const ChatBackgroundLayer: React.FC = () => {
  // useSyncExternalStore：首次渲染与订阅生效之间到达的主进程初始值 / 主题变更也不会丢
  const s = useSyncExternalStore(subscribeChatBackground, getChatBackground);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  const active = theme.pref === 'image';
  useEffect(() => {
    const root = document.documentElement;
    if (active) root.dataset.chatBg = 'image';
    else delete root.dataset.chatBg;
    return () => {
      delete root.dataset.chatBg;
    };
  }, [active]);
  // 运行中图片被删 / 移走：加载失败时让主进程重新校验，回退到内置预设
  useEffect(() => {
    if (!active || !s.imageUrl || typeof Image === 'undefined') return;
    let cancelled = false;
    const probe = new Image();
    probe.onerror = () => {
      if (!cancelled) void revalidateChatBackground();
    };
    probe.src = s.imageUrl;
    return () => {
      cancelled = true;
      probe.onerror = null;
    };
  }, [active, s.imageUrl]);
  if (!active) return null;
  return createPortal(
    <div className="chat-bg-layer" data-testid="chat-bg-layer" aria-hidden style={chatBgStyle(s)}>
      <div className="chat-bg-image" data-testid="chat-bg-image" />
      <div className="chat-bg-mask" data-testid="chat-bg-mask" />
    </div>,
    document.body,
  );
};
