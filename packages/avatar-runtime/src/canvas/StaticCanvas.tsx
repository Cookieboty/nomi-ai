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
    let ready = false;
    let frame: number | null = null;
    const img = new Image();
    img.decoding = 'async';
    const draw = () => {
      frame = null;
      if (cancelled || !ready) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      // A new/hidden WebView may not have laid out the canvas yet. Natural image dimensions
      // are not a substitute for the window layout; ResizeObserver will retry when it is ready.
      if (cssW <= 0 || cssH <= 0 || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
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
    const scheduleDraw = () => {
      if (cancelled || !ready || frame !== null) return;
      frame = window.requestAnimationFrame(draw);
    };
    img.onload = async () => {
      // SVGs can contain raster images. Wait for decoding before submitting the first frame,
      // but retain the successful load fallback for WebViews that reject decode() for SVGs.
      try {
        await img.decode?.();
      } catch {
        if (!img.complete || img.naturalWidth <= 0) return;
      }
      if (cancelled) return;
      ready = true;
      scheduleDraw();
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleDraw);
    observer?.observe(canvas);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleDraw();
    };
    window.addEventListener('resize', scheduleDraw);
    window.addEventListener('pageshow', scheduleDraw);
    document.addEventListener('visibilitychange', onVisibilityChange);
    img.src = url;
    return () => {
      cancelled = true;
      img.onload = null;
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleDraw);
      window.removeEventListener('pageshow', scheduleDraw);
      document.removeEventListener('visibilitychange', onVisibilityChange);
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
