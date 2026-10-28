import React, { lazy, useCallback, useState } from 'react';

import {
  getCharacterMode,
  getRiveConfig,
  getSpriteManifestPath,
  getStaticSrc,
  useCharacterPackReady,
} from '../../mascot/characterConfig';

// Rive is the default 2D renderer; the layered Canvas2D rig (SpriteCanvas) stays as the fallback
// for machines where the Rive wasm / scene cannot start. Static packs skip both.
const RiveCanvas = lazy(() => import('../RiveMascot/RiveCanvas'));
const SpriteCanvas = lazy(() => import('../SpriteMascot/SpriteCanvas'));
const StaticCanvas = lazy(() => import('../StaticMascot/StaticCanvas'));

export interface Nomi2DCanvasProps {
  /** URL of the sprite manifest used by the fallback renderer. */
  manifestPath: string;
}

/**
 * Bundled 2D mascot host: mode from the bundled character pack, overridden by Scheme B overlay
 * once `useCharacterPackReady` settles (avoids racing sync getCharacterMode before overlay IPC).
 * - rive: Rive first, sprite fallback
 * - sprite: layered rig only
 * - static: single image (no riv / 43 actions)
 */
export const Nomi2DCanvas: React.FC<Nomi2DCanvasProps> = ({ manifestPath }) => {
  const overlayReady = useCharacterPackReady();
  const [riveFailed, setRiveFailed] = useState(false);
  const onRiveFailure = useCallback(() => {
    document.documentElement.dataset.mascotRenderer = 'sprite-fallback';
    setRiveFailed(true);
  }, []);

  // Wait for Scheme B overlay IPC so mode / asset URLs are final before first paint.
  if (!overlayReady) return null;

  const mode = getCharacterMode();
  if (mode === 'static') return <StaticCanvas src={getStaticSrc()} />;
  const spriteManifest = getSpriteManifestPath(manifestPath);
  if (mode === 'sprite' || riveFailed) {
    return <SpriteCanvas manifestPath={spriteManifest} transparent />;
  }
  return <RiveCanvas src={getRiveConfig().src} onFailure={onRiveFailure} />;
};

export default Nomi2DCanvas;
