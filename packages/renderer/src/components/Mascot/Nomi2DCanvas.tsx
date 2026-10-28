import { AvatarStage, type AvatarWindowHost } from '@nomi-ai/avatar-runtime';
import { perfMark } from '@nomi-ai/ui';
import riveWasmUrl from '@rive-app/canvas-lite/rive.wasm?url';
import React, { useMemo } from 'react';

import { currentAvatarCharacter, resolveBundledAsset } from '../../avatar/character';
import { avatarEvents } from '../../avatar/events';
import { handleAvatarInteraction, reportAvatarEvent } from '../../avatar/interaction';
import { createMascotWindowHost } from '../../avatar/windowHost';
import { useCharacterPackReady } from '../../mascot/characterConfig';
import { hasTransport } from '../../services/api';

export interface Nomi2DCanvasProps {
  /** URL of the sprite manifest used by the fallback renderer. */
  manifestPath: string;
}

const DEV = process.env.NODE_ENV === 'development';

/**
 * Mascot window → avatar-runtime adapter: waits for the Scheme B overlay so mode / asset URLs are
 * final before first paint, then mounts `AvatarStage` with the window's event hub, the contract
 * window host (click-through / drag; only when the contract transport exists), the bubble /
 * speech handler for interaction output and the semantic reporter (touched / clicked / scene → AI).
 */
export const Nomi2DCanvas: React.FC<Nomi2DCanvasProps> = ({ manifestPath }) => {
  const overlayReady = useCharacterPackReady();
  const character = useMemo(
    () => (overlayReady ? currentAvatarCharacter(manifestPath) : null),
    [overlayReady, manifestPath],
  );
  const windowHost = useMemo<AvatarWindowHost | null>(
    () => (hasTransport() ? createMascotWindowHost() : null),
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

export default Nomi2DCanvas;
