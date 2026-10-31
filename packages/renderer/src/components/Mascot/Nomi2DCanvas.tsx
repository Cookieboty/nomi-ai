import { AvatarStage, type AvatarWindowHost } from '@nomi-ai/avatar-runtime';
import { perfMark } from '@nomi-ai/ui';
import riveWasmUrl from '@rive-app/canvas-lite/rive.wasm?url';
import React, { useEffect, useMemo, useState } from 'react';

import { currentAvatarCharacter, resolveBundledAsset } from '../../avatar/character';
import { avatarEvents } from '../../avatar/events';
import { handleAvatarInteraction, reportAvatarEvent } from '../../avatar/interaction';
import { createMascotWindowHost } from '../../avatar/windowHost';
import { getOverlay, useCharacterPackReady } from '../../mascot/characterConfig';
import {
  bundledRiveIsRemote,
  loadStaticArtUrl,
  useMascotRenderer,
  useRemoteRiveUrl,
} from '../../mascot/rendererChoice';
import { hasWindowHost } from '../../services/api';

export interface Nomi2DCanvasProps {
  /** URL of the sprite manifest used by the fallback renderer. */
  manifestPath: string;
}

const DEV = process.env.NODE_ENV === 'development';

/**
 * Mascot window → avatar-runtime adapter: waits for the Scheme B overlay so mode / asset URLs are
 * final before first paint, then mounts `AvatarStage` with the window's event hub, the contract
 * window host (click-through / drag; only inside the host's mascot window, not on the dev:web page), the bubble /
 * speech handler for interaction output and the semantic reporter (touched / clicked / scene → AI).
 */
export const Nomi2DCanvas: React.FC<Nomi2DCanvasProps> = ({ manifestPath }) => {
  const overlayReady = useCharacterPackReady();
  const renderer = useMascotRenderer();
  // 内置包的 .riv 是远程素材时：选了 Rive 也要等内核下载好（就绪前按静态立绘显示）
  const remoteRive = overlayReady && !getOverlay() && bundledRiveIsRemote();
  const riveUrl = useRemoteRiveUrl(remoteRive && renderer === 'rive');
  const wantStatic = renderer === 'svg' || (renderer === 'rive' && remoteRive && !riveUrl);
  const staticArt = useStaticArt(overlayReady && wantStatic && !getOverlay());
  const character = useMemo(() => {
    if (!overlayReady || !renderer) return null;
    const base = currentAvatarCharacter(manifestPath);
    // 设置为静态（默认）时内置包用它自己的静态立绘（覆盖包按自己的 manifest）；立绘地址到位前不挂角色。
    // 包没有静态立绘（'none'）或加载失败时按包自己的模式，不换成别的包的立绘
    if (wantStatic && !getOverlay() && staticArt !== 'failed' && staticArt !== 'none') {
      if (!staticArt) return null;
      return { ...base, mode: 'static' as const, assets: { ...base.assets, static: staticArt } };
    }
    if (riveUrl) return { ...base, assets: { ...base.assets, rive: riveUrl } };
    return base;
  }, [overlayReady, renderer, wantStatic, riveUrl, staticArt, manifestPath]);
  const windowHost = useMemo<AvatarWindowHost | null>(
    () => (hasWindowHost() ? createMascotWindowHost() : null),
    [],
  );

  if (!character) return null;
  return (
    <AvatarStage
      character={character}
      resolveAsset={resolveBundledAsset}
      events={avatarEvents}
      onInteraction={handleAvatarInteraction}
      onAvatarEvent={reportAvatarEvent}
      windowHost={windowHost}
      riveWasmUrl={riveWasmUrl}
      onMark={perfMark}
      debugHandles={DEV}
    />
  );
};

/**
 * 内置包的静态立绘地址（只在需要时加载）；包没有静态立绘为 'none'，加载失败为 'failed'，
 * 这两种情况调用方都按包自己的模式渲染
 */
function useStaticArt(wanted: boolean): string | 'none' | 'failed' | null {
  const [url, setUrl] = useState<string | 'none' | 'failed' | null>(null);
  useEffect(() => {
    if (!wanted || url) return;
    let alive = true;
    loadStaticArtUrl()
      .then((u) => alive && setUrl(u ?? 'none'))
      .catch(() => alive && setUrl('failed'));
    return () => {
      alive = false;
    };
  }, [wanted, url]);
  return url;
}

export default Nomi2DCanvas;
