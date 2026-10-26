import { useEffect, useRef, useState } from 'react';

import { selectFirstMessageId, useAiChatSelector } from '../../contexts/aiChatStore';
import {
  MEDIA_OPEN_EVENT,
  MEDIA_TOAST_EVENT,
  describeChange,
  mediaClient,
  useMediaState,
  type MediaOpenDetail,
} from '../../services/mediaClient';

import { AssetLibrary } from './AssetLibrary';
import { ImageStudio } from './ImageStudio';
import styles from './Media.module.css';
import { MediaNav, type MediaView } from './MediaNav';

/**
 * 生图宿主：侧栏固定入口 + 主区域整页（工作台 / 素材库替换对话区，侧栏保持）、窗口事件、
 * 主进程自动切换供应商提示。切到别的会话或新对话时自动回到对话。
 */
export function useMediaHost(
  collapsed: boolean,
  onNewChat: () => unknown,
  openSettings: (section: 'models') => void,
  toast: (msg: string) => void,
) {
  const [view, setView] = useState<MediaView>('chat');
  const [studioPrompt, setStudioPrompt] = useState<string | undefined>();
  // 页面首次打开后保持挂载（切回对话只隐藏），保留工作台草稿与滚动位置
  const [mounted, setMounted] = useState<{ studio?: boolean; library?: boolean }>({});
  const [mediaState] = useMediaState();
  const show = (v: MediaView) => {
    setView(v);
    if (v !== 'chat') setMounted((m) => ({ ...m, [v]: true }));
  };
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<MediaOpenDetail>).detail;
      if (!d) return;
      if (d.target === 'settings') return openSettings('models');
      if (d.target === 'studio' && d.prompt) setStudioPrompt(d.prompt);
      show(d.target);
    };
    const onToast = (e: Event) => toast((e as CustomEvent<string>).detail);
    window.addEventListener(MEDIA_OPEN_EVENT, onOpen);
    window.addEventListener(MEDIA_TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(MEDIA_OPEN_EVENT, onOpen);
      window.removeEventListener(MEDIA_TOAST_EVENT, onToast);
    };
  }, [openSettings, toast]);
  useEffect(
    () => mediaClient.onNotice((c) => toast(describeChange(mediaState, c))),
    [mediaState, toast],
  );
  // 在侧栏点了别的会话 → 回到对话
  const first = useAiChatSelector(selectFirstMessageId);
  const lastFirst = useRef(first);
  useEffect(() => {
    if (lastFirst.current !== first) setView('chat');
    lastFirst.current = first;
  }, [first]);

  const nav = (
    <MediaNav
      collapsed={collapsed}
      active={view}
      onNewChat={() => {
        setView('chat');
        void onNewChat();
      }}
      onStudio={() => show('studio')}
      onLibrary={() => show('library')}
    />
  );
  const page = (
    <div className={styles.mediaMain} hidden={view === 'chat'} data-testid="media-main">
      {mounted.studio && (
        <div className={styles.mediaMain} hidden={view !== 'studio'}>
          <ImageStudio active={view === 'studio'} prompt={studioPrompt} />
        </div>
      )}
      {mounted.library && (
        <div className={styles.mediaMain} hidden={view !== 'library'}>
          <AssetLibrary active={view === 'library'} />
        </div>
      )}
    </div>
  );
  return { nav, page, view, chatHidden: view !== 'chat' };
}
