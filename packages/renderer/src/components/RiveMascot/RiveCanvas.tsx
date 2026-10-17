import { Alignment, Fit, Layout, Rive, RuntimeLoader } from '@rive-app/canvas-lite';
import riveWasmUrl from '@rive-app/canvas-lite/rive.wasm?url';
import React, { useEffect, useRef, useState } from 'react';

import { createRiveBackend } from '../../mascot/backends/rive';
import { mascotRegistry } from '../../mascot/MascotBackend';
import { characterBox } from '../../mascot/spriteLayout';

import MascotInteractionLayerLite, {
  type SpriteGeometry,
} from '../SpriteMascot/InteractionLite';

export interface RiveCanvasProps {
  /** URL of the high-fidelity .riv (default: public/assets/models/rive/nomi-complete.riv). */
  src?: string;
  style?: React.CSSProperties;
}

const DEFAULT_SRC = './assets/models/rive/nomi-complete.riv';
const FULL_SRC = './assets/models/rive/nomi-complete.riv';

/**
 * Rive renderer. The wasm is bundled — the
 * runtime's default CDN URL would be blocked by the app CSP (connect-src 'self') — and the page CSP
 * needs 'wasm-unsafe-eval' for it to compile (see docs/brand/rive-complete.md).
 */
export const RiveCanvas: React.FC<RiveCanvasProps> = ({ src = DEFAULT_SRC, style }) => {
  const fullBody = typeof location !== 'undefined' && new URLSearchParams(location.search).get('rive') === 'full';
  const resolvedSrc = src === DEFAULT_SRC && fullBody ? FULL_SRC : src;
  const stateMachine = fullBody ? 'NomiFull' : 'Nomi';
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geometry = useRef<SpriteGeometry>({ head: null, body: null });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    RuntimeLoader.setWasmUrl(riveWasmUrl);
    let rive: Rive | null = null;
    let detach: (() => void) | null = null;
    const place = () => {
      const b = characterBox(wrap.clientWidth, wrap.clientHeight);
      Object.assign(canvas.style, {
        left: `${b.x}px`,
        top: `${b.y}px`,
        width: `${b.w}px`,
        height: `${b.h}px`,
      });
      // Rive draws into the positioned canvas, so keep the same window-space
      // geometry contract used by SpriteCanvas. This is also the fallback hit
      // region when the GPU/runtime canvas has no readable alpha channel.
      const r = canvas.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        geometry.current = {
          head: {
            left: r.left + r.width * 0.16,
            right: r.right - r.width * 0.16,
            top: r.top + r.height * 0.04,
            bottom: r.top + r.height * 0.42,
          },
          body: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        };
      }
      rive?.resizeDrawingSurfaceToCanvas();
    };
    place();
    try {
      rive = new Rive({
        src: resolvedSrc,
        artboard: fullBody ? 'Nomi-full' : 'Nomi',
        canvas,
        autoplay: true,
        autoBind: true,
        stateMachines: stateMachine,
        layout: new Layout({ fit: Fit.Contain, alignment: Alignment.BottomCenter }),
        onLoad: () => {
          place();
          const backend = createRiveBackend(() => rive?.viewModelInstance);
          detach = mascotRegistry.attach(backend);
          if (process.env.NODE_ENV === 'development') {
            (globalThis as { __nomiMascot?: unknown }).__nomiMascot = backend;
          }
        },
        onLoadError: () => setError('Rive load failed'),
      });
    } catch (e) {
      console.error('[rive] init failed', e);
    }
    const ro = new ResizeObserver(place);
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      detach?.();
      rive?.cleanup();
    };
  }, [resolvedSrc, stateMachine]);

  return (
    <div
      ref={wrapRef}
      data-testid="rive-canvas"
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        background: 'transparent',
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        // Keep the canvas the sole pointer target for both the Rive runtime and
        // InteractionLite.  Explicit pointer-events avoids transparent-window
        // CSS resets in host pages disabling pointerdown/capture on Chromium.
        style={{
          position: 'absolute',
          display: 'block',
          pointerEvents: 'auto',
          touchAction: 'none',
          userSelect: 'none',
        }}
      />
      <MascotInteractionLayerLite
        canvasRef={canvasRef}
        geometry={geometry}
        registry={mascotRegistry}
      />
      {error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#f88',
            fontSize: 13,
          }}
        >
          Rive error: {error}
        </div>
      )}
    </div>
  );
};

export default RiveCanvas;
