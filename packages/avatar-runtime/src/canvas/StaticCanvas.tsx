import React, { useEffect, useMemo, useRef, useState } from 'react';

import { createStaticBackend } from '../backends/static';
import { useAvatarContext } from '../host';
import { characterBox } from '../spriteLayout';

import MascotInteractionLayerLite, { type SpriteGeometry } from './InteractionLite';

export interface StaticCanvasProps {
  /** URL of the static character image (the character's `assets.static`, resolved). */
  src: string;
  /** Optional blink frame for a tiny idle flicker. */
  blinkSrc?: string;
  style?: React.CSSProperties;
}

function measureGeometry(canvas: HTMLCanvasElement | null): SpriteGeometry {
  if (!canvas) return { head: null, body: null, box: null };
  const r = canvas.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return { head: null, body: null, box: null };
  const b = characterBox(r.width, r.height);
  if (b.w <= 0 || b.h <= 0) return { head: null, body: null, box: null };
  const left = r.left + b.x;
  const top = r.top + b.y;
  const right = left + b.w;
  const bottom = top + b.h;
  const box = { left, right, top, bottom };
  return {
    head: {
      left: left + b.w * 0.16,
      right: right - b.w * 0.16,
      top: top + b.h * 0.04,
      bottom: top + b.h * 0.42,
    },
    body: box,
    box,
  };
}

/**
 * First-class static mascot: paints a single (optionally two-frame) image onto a canvas
 * so InteractionLite alpha hit-testing / drag still works. Motions are no-ops.
 */
export const StaticCanvas: React.FC<StaticCanvasProps> = ({
  src: resolvedSrc,
  blinkSrc,
  style,
}) => {
  const { mark, runtime } = useAvatarContext();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [blink, setBlink] = useState(false);
  const geometry = useMemo(
    () => ({
      get current(): SpriteGeometry {
        return measureGeometry(canvasRef.current);
      },
    }),
    [],
  );

  useEffect(() => {
    const backend = createStaticBackend();
    const detach = runtime.registry.attach(backend);
    runtime.flag('mascotRenderer', 'static');
    mark('mascot-model-loaded');
    mark('static-model-loaded');
    return () => {
      detach();
      backend.dispose();
    };
    // mark is stable per stage
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!blinkSrc) return undefined;
    let alive = true;
    const loop = () => {
      const delay = 4000 + Math.random() * 4000;
      return window.setTimeout(() => {
        if (!alive) return;
        setBlink(true);
        window.setTimeout(() => alive && setBlink(false), 120);
        timer = loop();
      }, delay);
    };
    let timer = loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [blinkSrc]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const url = blink && blinkSrc ? blinkSrc : resolvedSrc;
    let cancelled = false;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (cancelled) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const cssW = canvas.clientWidth || img.naturalWidth;
      const cssH = canvas.clientHeight || img.naturalHeight;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      // contain + bottom-center inside the character box (same box as RiveCanvas and the hit
      // geometry above; the window's side / top padding is reserved for the toolbar and bubble)
      const b = characterBox(cssW, cssH);
      const scale = Math.min(b.w / img.naturalWidth, b.h / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      const dx = b.x + (b.w - dw) / 2;
      const dy = b.y + b.h - dh;
      ctx.drawImage(img, dx, dy, dw, dh);
    };
    img.src = url;
    const onResize = () => {
      // re-trigger draw by reassigning src if already loaded
      if (img.complete && img.naturalWidth > 0) img.onload?.(new Event('load') as never);
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
    };
  }, [resolvedSrc, blinkSrc, blink]);

  return (
    <div
      data-testid="static-canvas"
      data-static-src={resolvedSrc}
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
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          display: 'block',
          pointerEvents: 'auto',
          touchAction: 'none',
          userSelect: 'none',
        }}
      />
      <MascotInteractionLayerLite
        canvasRef={canvasRef}
        geometry={geometry}
        registry={runtime.registry}
      />
    </div>
  );
};

export default StaticCanvas;
