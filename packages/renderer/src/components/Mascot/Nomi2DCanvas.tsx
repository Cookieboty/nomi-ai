import React, { lazy, useCallback, useEffect, useState } from 'react';

import { ensureCharacterPackOverlay, getCharacterMode } from '../../mascot/characterConfig';

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
 * Bundled 2D mascot host: mode from character.generated.json.
 * - rive: Rive first, sprite fallback
 * - sprite: layered rig only
 * - static: single image (no riv / 43 actions)
 */
export const Nomi2DCanvas: React.FC<Nomi2DCanvasProps> = ({ manifestPath }) => {
  useEffect(() => {
    void ensureCharacterPackOverlay();
  }, []);
  const mode = getCharacterMode();
  const [riveFailed, setRiveFailed] = useState(false);
  const onRiveFailure = useCallback(() => {
    document.documentElement.dataset.mascotRenderer = 'sprite-fallback';
    setRiveFailed(true);
  }, []);

  if (mode === 'static') return <StaticCanvas />;
  if (mode === 'sprite') return <SpriteCanvas manifestPath={manifestPath} transparent />;
  if (riveFailed) return <SpriteCanvas manifestPath={manifestPath} transparent />;
  return <RiveCanvas onFailure={onRiveFailure} />;
};

export default Nomi2DCanvas;
