import React, { lazy, Suspense, useCallback, useState } from 'react';

import { assetUrl, useAvatarContext, type AvatarCharacter } from '../host';

// Rive is the default 2D renderer; the layered Canvas2D rig (SpriteCanvas) stays as the fallback
// for machines where the Rive wasm / scene cannot start. Static packs skip both.
const RiveCanvas = lazy(() => import('./RiveCanvas'));
const SpriteCanvas = lazy(() => import('./SpriteCanvas'));
const StaticCanvas = lazy(() => import('./StaticCanvas'));

export interface AvatarCanvasProps {
  character: AvatarCharacter;
  resolveAsset(path: string): string;
}

/**
 * Picks the renderer from the character's mode:
 * - rive: Rive first, sprite fallback
 * - sprite: layered rig only
 * - static: single image (no riv / 43 actions)
 */
export const AvatarCanvas: React.FC<AvatarCanvasProps> = ({ character, resolveAsset }) => {
  const { runtime } = useAvatarContext();
  const [riveFailed, setRiveFailed] = useState(false);
  const onRiveFailure = useCallback(() => {
    runtime.flag('mascotRenderer', 'sprite-fallback');
    setRiveFailed(true);
  }, [runtime]);

  const { mode, assets } = character;
  let canvas: React.ReactElement;
  if (mode === 'static') {
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
