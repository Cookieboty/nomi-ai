import React, { lazy, useCallback, useState } from 'react';

// Rive is the default 2D renderer; the layered Canvas2D rig (SpriteCanvas) stays as the fallback
// for machines where the Rive wasm / scene cannot start. Both are lazy so only one is ever paid for.
const RiveCanvas = lazy(() => import('../RiveMascot/RiveCanvas'));
const SpriteCanvas = lazy(() => import('../SpriteMascot/SpriteCanvas'));

export interface Nomi2DCanvasProps {
  /** URL of the sprite manifest used by the fallback renderer. */
  manifestPath: string;
}

/**
 * The bundled Nomi 2D mascot: Rive first, layered 2D rig if Rive fails to initialise. The fallback
 * is announced with `<html data-mascot-renderer="sprite-fallback">` for diagnostics / e2e.
 */
export const Nomi2DCanvas: React.FC<Nomi2DCanvasProps> = ({ manifestPath }) => {
  const [riveFailed, setRiveFailed] = useState(false);
  const onRiveFailure = useCallback(() => {
    document.documentElement.dataset.mascotRenderer = 'sprite-fallback';
    setRiveFailed(true);
  }, []);
  if (riveFailed) return <SpriteCanvas manifestPath={manifestPath} transparent />;
  return <RiveCanvas onFailure={onRiveFailure} />;
};

export default Nomi2DCanvas;
