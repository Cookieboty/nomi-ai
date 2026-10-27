import { perfMark } from '@nomi-ai/ui';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { createStaticBackend } from '../../mascot/backends/static';
import { ensureCharacterPackOverlay, getStaticSrc } from '../../mascot/characterConfig';
import { mascotRegistry } from '../../mascot/MascotBackend';
import { characterBox } from '../../mascot/spriteLayout';
import MascotInteractionLayerLite, { type SpriteGeometry } from '../SpriteMascot/InteractionLite';

export interface StaticCanvasProps {
  /** URL of the static character image (default from character.generated.json). */
  src?: string;
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
  src = getStaticSrc(),
  blinkSrc,
  style,
}) => {
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
    void ensureCharacterPackOverlay();
  }, []);

  useEffect(() => {
    const backend = createStaticBackend();
    const detach = mascotRegistry.attach(backend);
    document.documentElement.dataset.mascotRenderer = 'static';
    perfMark('mascot-model-loaded');
    perfMark('static-model-loaded');
    return () => {
      detach();
      backend.dispose();
    };
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
    const url = blink && blinkSrc ? blinkSrc : src;
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
      // contain + bottom-center (match previous <img> objectFit)
      const scale = Math.min(cssW / img.naturalWidth, cssH / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      const dx = (cssW - dw) / 2;
      const dy = cssH - dh;
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
  }, [src, blinkSrc, blink]);

  return (
    <div
      data-testid="static-canvas"
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
        registry={mascotRegistry}
      />
    </div>
  );
};

export default StaticCanvas;
