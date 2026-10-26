import { useEffect, useState } from 'react';

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
import { MediaNav } from './MediaNav';

/** 生图宿主：工作台 / 素材库覆盖层、窗口事件、主进程自动切换供应商提示 */
export function useMediaHost(
  collapsed: boolean,
  onNewChat: () => unknown,
  openSettings: (section: 'models') => void,
  toast: (msg: string) => void,
) {
  const [studio, setStudio] = useState<{ prompt?: string } | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [mediaState] = useMediaState();
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<MediaOpenDetail>).detail;
      if (!d) return;
      if (d.target === 'settings') openSettings('models');
      else if (d.target === 'studio') setStudio(d.prompt ? { prompt: d.prompt } : {});
      else setShowLibrary(true);
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

  const nav = (
    <MediaNav
      collapsed={collapsed}
      onNewChat={() => void onNewChat()}
      onStudio={() => setStudio({})}
      onLibrary={() => setShowLibrary(true)}
    />
  );
  const overlays = (
    <>
      <ImageStudio open={!!studio} prompt={studio?.prompt} onClose={() => setStudio(null)} />
      <AssetLibrary open={showLibrary} onClose={() => setShowLibrary(false)} />
    </>
  );
  return { nav, overlays };
}
