import React, { lazy, Suspense, useCallback, useState } from 'react';

import { assetUrl, useAvatarContext, type AvatarCharacter } from '../host';

// When the Rive wasm / scene cannot start, the character falls back to its static image; only a pack
// without one falls back to the layered Canvas2D rig (SpriteCanvas, also used by sprite-mode packs).
// Static packs skip both.
const RiveCanvas = lazy(() => import('./RiveCanvas'));
const SpriteCanvas = lazy(() => import('./SpriteCanvas'));
const StaticCanvas = lazy(() => import('./StaticCanvas'));

export interface AvatarCanvasProps {
  character: AvatarCharacter;
  resolveAsset(path: string): string;
}

/**
 * Picks the renderer from the character's mode:
 * - rive: Rive first; on failure the static image, else the layered rig
 * - sprite: layered rig only
 * - static: single image (no riv / 43 actions)
 */
export const AvatarCanvas: React.FC<AvatarCanvasProps> = ({ character, resolveAsset }) => {
  const { runtime } = useAvatarContext();
  const [riveFailed, setRiveFailed] = useState(false);
  const { mode, assets } = character;
  const staticFallback = !!assets.static;
  const onRiveFailure = useCallback(() => {
    runtime.flag('mascotRenderer', staticFallback ? 'static-fallback' : 'sprite-fallback');
    setRiveFailed(true);
  }, [runtime, staticFallback]);

  let canvas: React.ReactElement;
  if (mode === 'static' || (riveFailed && staticFallback)) {
    canvas = <StaticCanvas src={assetUrl(assets.static, resolveAsset)} />;
  } else if (mode === 'sprite' || riveFailed) {
    canvas = (
      <SpriteCanvas manifestPath={assetUrl(assets.spriteManifest, resolveAsset)} transparent />
    );
  } else {
    canvas = (
      <RiveCanvas
        src={assetUrl(assets.rive, resolveAsset)}
        artboard={character.rive?.artboard}
        stateMachine={character.rive?.stateMachine}
        onFailure={onRiveFailure}
      />
    );
  }
  return <Suspense fallback={null}>{canvas}</Suspense>;
};

export default AvatarCanvas;
