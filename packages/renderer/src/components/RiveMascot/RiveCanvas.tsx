import { perfMark } from '@nomi-ai/ui';
import { Alignment, Fit, Layout, Rive, RuntimeLoader } from '@rive-app/canvas-lite';
import riveWasmUrl from '@rive-app/canvas-lite/rive.wasm?url';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { createRiveBackend } from '../../mascot/backends/rive';
import { mascotRegistry } from '../../mascot/MascotBackend';
import { characterBox } from '../../mascot/spriteLayout';
import MascotInteractionLayerLite, { type SpriteGeometry } from '../SpriteMascot/InteractionLite';

export interface RiveCanvasProps {
  /** URL of the high-fidelity .riv (default: public/assets/models/rive/nomi-complete.riv). */
  src?: string;
  style?: React.CSSProperties;
  /**
   * Called once when Rive cannot start (wasm compile / fetch failure, .riv load error, constructor
   * throw, or no load within RIVE_LOAD_TIMEOUT_MS). The host swaps in the layered 2D renderer.
   */
  onFailure?: (reason: string) => void;
}

/** Rive normally loads in a few seconds even on software rendering; beyond this we fall back. */
export const RIVE_LOAD_TIMEOUT_MS = 20_000;

const DEFAULT_SRC = './assets/models/rive/nomi-complete.riv';

/**
 * Window-space geometry of the character, measured from the live layout every time it is read.
 * Interaction reports the body box to the main process, which uses it as the feet anchor while
 * the window is being resized (wheel zoom). A cached copy that is only refreshed by a
 * ResizeObserver lags one resize behind the window and makes the anchor drift.
 */
function measureGeometry(wrap: HTMLElement | null): SpriteGeometry {
  if (!wrap) return { head: null, body: null };
  const b = characterBox(wrap.clientWidth, wrap.clientHeight);
  if (b.w <= 0 || b.h <= 0) return { head: null, body: null };
  const r = wrap.getBoundingClientRect();
  const left = r.left + b.x;
  const top = r.top + b.y;
  const right = left + b.w;
  const bottom = top + b.h;
  return {
    head: {
      left: left + b.w * 0.16,
      right: right - b.w * 0.16,
      top: top + b.h * 0.04,
      bottom: top + b.h * 0.42,
    },
    body: { left, right, top, bottom },
  };
}

/**
 * Rive renderer. The wasm is bundled — the
 * runtime's default CDN URL would be blocked by the app CSP (connect-src 'self') — and the page CSP
 * needs 'wasm-unsafe-eval' for it to compile (see docs/brand/rive-complete.md).
 */
export const RiveCanvas: React.FC<RiveCanvasProps> = ({ src = DEFAULT_SRC, style, onFailure }) => {
  const onFailureRef = useRef(onFailure);
  useEffect(() => {
    onFailureRef.current = onFailure;
  });
  // The production scene has one source of truth: the full-body SVG-backed rig.
  // Keep the artboard selection unconditional so the removed half-body rig cannot
  // be selected by a stale query string or an old local preference.
  const resolvedSrc = src;
  const stateMachine = 'NomiFull';
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geometry = useMemo(
    () => ({
      get current(): SpriteGeometry {
        return measureGeometry(wrapRef.current);
      },
    }),
    [],
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    RuntimeLoader.setWasmUrl(riveWasmUrl);
    let rive: Rive | null = null;
    let detach: (() => void) | null = null;
    let settled = false;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimer);
      console.error('[rive] unavailable, falling back to the layered 2D renderer:', reason);
      setError(reason);
      onFailureRef.current?.(reason);
    };
    const place = () => {
      const b = characterBox(wrap.clientWidth, wrap.clientHeight);
      Object.assign(canvas.style, {
        left: `${b.x}px`,
        top: `${b.y}px`,
        width: `${b.w}px`,
        height: `${b.h}px`,
      });
      rive?.resizeDrawingSurfaceToCanvas();
    };
    place();
    try {
      rive = new Rive({
        src: resolvedSrc,
        artboard: 'Nomi-full',
        canvas,
        autoplay: true,
        autoBind: true,
        stateMachines: stateMachine,
        layout: new Layout({ fit: Fit.Contain, alignment: Alignment.BottomCenter }),
        onLoad: () => {
          if (settled) return;
          settled = true;
          clearTimeout(loadTimer);
          place();
          const backend = createRiveBackend(() => rive?.viewModelInstance);
          detach = mascotRegistry.attach(backend);
          if (process.env.NODE_ENV === 'development') {
            (globalThis as { __nomiMascot?: unknown }).__nomiMascot = backend;
          }
          // same readiness signals the sprite / VRM renderers emit (dev-smoke, startup measurement)
          perfMark('mascot-model-loaded');
          perfMark('rive-model-loaded');
        },
        // e2e / diagnostics probe, same contract as the layered rig: <html data-mascot-action="wave">
        // while a named clip plays, empty at rest. The state machine reports `full.<clip>` / `rest`.
        onStateChange: (e) => {
          const names = Array.isArray(e.data) ? (e.data as unknown[]) : [];
          const clip = names.find(
            (n): n is string => typeof n === 'string' && n.startsWith('full.') && n !== 'full.idle',
          );
          document.documentElement.dataset.mascotAction = clip ? clip.slice('full.'.length) : '';
        },
        onLoadError: () => fail('Rive load failed'),
      });
      loadTimer = setTimeout(() => fail('Rive did not load in time'), RIVE_LOAD_TIMEOUT_MS);
    } catch (e) {
      fail(`Rive init failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const ro = new ResizeObserver(place);
    ro.observe(wrap);
    // window resize events fire before the next frame's rAF callbacks (ResizeObserver runs after
    // them), so the canvas is already placed when the interaction loop reads the geometry
    window.addEventListener('resize', place);
    return () => {
      settled = true;
      clearTimeout(loadTimer);
      window.removeEventListener('resize', place);
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
