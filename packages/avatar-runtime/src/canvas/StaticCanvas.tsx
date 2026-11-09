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

/** 立绘画完是空的时最多再画几次（50ms、100ms、150ms…递增） */
const MAX_REDRAWS = 8;

/** 画出的区域里有没有不透明的像素（隔行隔列抽样）；读不了像素时按画上了算 */
export function painted(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  const sx = Math.max(0, Math.floor(x));
  const sy = Math.max(0, Math.floor(y));
  const sw = Math.min(ctx.canvas.width - sx, Math.ceil(w));
  const sh = Math.min(ctx.canvas.height - sy, Math.ceil(h));
  if (sw <= 0 || sh <= 0) return true;
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(sx, sy, sw, sh).data;
  } catch {
    return true;
  }
  const step = Math.max(1, Math.floor(Math.min(sw, sh) / 24));
  for (let row = 0; row < sh; row += step) {
    for (let col = 0; col < sw; col += step) {
      if (data[(row * sw + col) * 4 + 3]! > 0) return true;
    }
  }
  return false;
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
    let retries = 0;
    let retryTimer = 0;
    let frame: number | null = null;
    const img = new Image();
    img.decoding = 'async';
    const draw = () => {
      frame = null;
      window.clearTimeout(retryTimer);
      if (cancelled || !ready || !img.naturalWidth || !img.naturalHeight) return;
      // 还没布局（窗口刚建、还没显示）时尺寸是 0：等 ResizeObserver 在布局后再画，不按图片原尺寸画
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW <= 0 || cssH <= 0) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
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
      // WebKit（macOS）：立绘是内嵌位图的 SVG，onload 时里面的位图可能还没解码，这一笔画出来是空的，
      // 要等下一次重画（以前是调整大小）才出现（#303）。画完看一眼，空的就退避着再画几次
      if (retries < MAX_REDRAWS && !painted(ctx, dx * dpr, dy * dpr, dw * dpr, dh * dpr)) {
        retries += 1;
        retryTimer = window.setTimeout(draw, 50 * retries);
      }
    };
    /** 同一帧里的多次重画请求（尺寸变化、窗口恢复、解码完成）合成一次（思路来自 #304） */
    const scheduleDraw = () => {
      if (cancelled || !ready || frame !== null) return;
      frame = window.requestAnimationFrame(draw);
    };
    img.onload = () => {
      if (cancelled) return;
      // 先解码再画：decoding=async 时 onload 早于解码完成
      const decoded = typeof img.decode === 'function' ? img.decode() : Promise.resolve();
      void decoded
        .catch(() => undefined)
        .then(() => {
          if (cancelled) return;
          ready = true;
          retries = 0;
          scheduleDraw();
        });
    };
    img.src = url;
    // 画布自己的尺寸变化（布局完成、显示开关重建、窗口缩放）都重画；没有 ResizeObserver 时退回窗口 resize
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleDraw) : null;
    ro?.observe(canvas);
    window.addEventListener('resize', scheduleDraw);
    // 窗口从隐藏恢复：尺寸没变、ResizeObserver 不会触发，但 WebKit 可能已丢掉隐藏时的画面，重新画并重新检查空白
    // （思路来自 #304）
    const onShown = () => {
      if (document.visibilityState !== 'visible') return;
      retries = 0;
      scheduleDraw();
    };
    document.addEventListener('visibilitychange', onShown);
    window.addEventListener('pageshow', onShown);
    return () => {
      cancelled = true;
      img.onload = null;
      window.clearTimeout(retryTimer);
      if (frame !== null) window.cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener('resize', scheduleDraw);
      document.removeEventListener('visibilitychange', onShown);
      window.removeEventListener('pageshow', onShown);
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
