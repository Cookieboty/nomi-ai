import React, { useEffect, useRef, useState } from 'react';

import { createSpriteBackend, loadSpriteManifest, type SpriteBackend } from '../backends/sprite';
import { useAvatarContext } from '../host';
import {
  drawRig,
  paintRigFrame,
  RigAnimator,
  RIG_LAYERS,
  rigBodyBox,
  rigHeadBox,
  rigTransform,
  type RigImages,
  type RigManifest,
} from '../layeredRig';
import { IdleBehavior } from '../rig/idleBehavior';
import { PoseGate } from '../rig/poseGate';
import { characterBox } from '../spriteLayout';

import MascotInteractionLayerLite, { type SpriteGeometry } from './InteractionLite';

/** 丢掉已解码的位图。只换 Map 的话，旧 Image 仍可能被未完成的 onload 写回来。 */
function releaseImages(map: { values(): Iterable<unknown>; clear(): void }): void {
  for (const img of map.values()) {
    if (!img || typeof img !== 'object') continue;
    const el = img as HTMLImageElement;
    el.onload = null;
    el.onerror = null;
    if (typeof el.src === 'string') el.src = '';
  }
  map.clear();
}

export interface SpriteCanvasProps {
  /** URL to manifest.json */
  manifestPath: string;
  className?: string;
  style?: React.CSSProperties;
  transparent?: boolean;
}

/**
 * 2D expression-swapped mascot (soft PNG or pixel pet), no three.js.
 */
export const SpriteCanvas: React.FC<SpriteCanvasProps> = ({
  manifestPath,
  className = '',
  style,
  transparent = true,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backendRef = useRef<SpriteBackend | null>(null);
  const imgs = useRef(new Map<string, HTMLImageElement>());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [styleKind, setStyleKind] = useState('soft');
  const styleKindRef = useRef('soft');
  const rigRef = useRef<RigManifest | null>(null);
  const animRef = useRef<RigAnimator | null>(null);
  const rigImgs = useRef<RigImages>(new Map());
  const geometry = useRef<SpriteGeometry>({ head: null, body: null, box: null });
  const { mark, debugHandles, runtime } = useAvatarContext();

  useEffect(() => {
    let cancelled = false;
    let detach: (() => void) | null = null;
    let raf = 0;
    // 切换 manifestPath 时重置就绪态与错误；外部数据同步模式，豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(false);
    setError(null);
    releaseImages(imgs.current);
    releaseImages(rigImgs.current);
    loadSpriteManifest(manifestPath)
      .then(({ manifest, baseUrl }) => {
        if (cancelled) return;
        const backend = createSpriteBackend(manifest, baseUrl);
        backendRef.current = backend;
        detach = runtime.registry.attach(backend);
        if (debugHandles) {
          // dev-only handle for visual checks / screenshots over CDP
          (globalThis as { __nomiMascot?: SpriteBackend }).__nomiMascot = backend;
        }
        const sk = manifest.style || 'soft';
        styleKindRef.current = sk;
        setStyleKind(sk);
        if (manifest.rig) {
          const rig = manifest.rig;
          rigRef.current = rig;
          animRef.current = new RigAnimator();
          if (debugHandles) {
            // dev-only: deterministic offscreen rendering for demo videos
            (globalThis as { __nomiRig?: unknown }).__nomiRig = {
              rig,
              imgs: rigImgs.current,
              RigAnimator,
              paintRigFrame,
              drawRig,
            };
          }
          const dir = rig.dir ?? 'layers/';
          const load = (key: string, file: string) =>
            new Promise<void>((resolve) => {
              const img = new Image();
              img.onload = () => {
                if (cancelled) return;
                rigImgs.current.set(key, img);
                resolve();
              };
              img.onerror = () => resolve();
              img.src = `${baseUrl}${dir}${file}`;
            });
          const rigLoads = [
            ...RIG_LAYERS.filter((n) => rig.layers[n]).map((n) => load(n, `${n}.png`)),
            // hand pieces of the mesh-warped arms (non-brand art, see docs/BRAND.md)
            ...Object.entries(rig.hands ?? {}).map(([n, h]) => load(`hand-${n}`, h.file)),
          ];
          return Promise.all(rigLoads).then(() => {
            if (cancelled) return;
            if (!rigImgs.current.has('body') || !rigImgs.current.has('head')) {
              throw new Error('rig layers missing');
            }
            setReady(true);
            runtime.flag('mascotModel', manifest.id);
            runtime.flag('mascotRig', 'layered');
            mark('mascot-model-loaded');
            mark('sprite-model-loaded', manifest.id);
          });
        }
        // preload
        const files = new Set([
          ...Object.values(manifest.expressions),
          manifest.blink,
          manifest.mouthOpen,
        ]);
        const loads = [...files].filter(Boolean).map(
          (f) =>
            new Promise<void>((resolve) => {
              const img = new Image();
              img.onload = () => {
                if (cancelled) return;
                imgs.current.set(`${baseUrl}${f}`, img);
                resolve();
              };
              img.onerror = () => resolve();
              img.src = `${baseUrl}${f}`;
            }),
        );
        return Promise.all(loads).then(() => {
          if (cancelled) return;
          setReady(true);
          runtime.flag('mascotModel', manifest.id);
          mark('mascot-model-loaded');
          mark('sprite-model-loaded', manifest.id);
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });

    rigRef.current = null;
    animRef.current = null;
    rigImgs.current = new Map();
    const reduceMq =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    let last = performance.now();
    let lastUserSig = '';
    let userAt = last;
    // 分开记：说话 / 表情 / 思考 / 动作（coreAt）与只是视线跟着光标动（lookAt）
    let lastCoreSig = '';
    let lastLookSig = '';
    let coreAt = last;
    let lookAt = last;
    /** 上一帧在说话 / 口型张着 / 有动作：下一帧照常满帧 */
    let lastHot = true;
    const poseGate = new PoseGate();
    let paintSeq = 0;
    const idleBehavior = new IdleBehavior();
    // e2e / perf probes: current action id + smoothed frame cost (ms), published every ~30 frames
    let probeAction = '';
    let frameMs = 0;
    let frameN = 0;
    // canvas 视口矩形缓存：窗口缩放时失效（位置移动不影响 client 坐标）
    let cachedRect: DOMRect | null = null;
    let cachedViewport = `${window.innerWidth}x${window.innerHeight}`;
    const onResize = () => {
      const viewport = `${window.innerWidth}x${window.innerHeight}`;
      if (viewport === cachedViewport) return;
      cachedViewport = viewport;
      cachedRect = null;
    };
    /**
     * 这一帧至少隔多久（ms，0 = 每帧都画）。说话 / 口型 / 动作 / 表情刚变（2 s 内）满帧；
     * 只是视线跟着光标动 ≈20 fps；空闲 ≈30 fps（与以前一样）；10 s 没有任何变化 ≈10 fps，
     * 但眨眼、眼神跳动、甩头发前后仍按 ≈30 fps 画（视线在动时眨眼满帧），看上去和以前一样。
     */
    const frameGap = (now: number, reduced: boolean): number => {
      if (reduced) return 30;
      const anim = animRef.current;
      if (!rigRef.current || !anim) return 0;
      if (lastHot || now - coreAt < 2000 || anim.actions.busy()) return 0;
      const quick = anim.quickMotionNear(now / 1000);
      if (now - lookAt < 2000) return quick ? 0 : 50;
      if (quick) return 30;
      if (now - Math.max(coreAt, lookAt, userAt) > 10_000) return 90;
      return 30;
    };
    const tick = (now: number) => {
      // pause entirely while the window is hidden / minimised (resumed by visibilitychange)
      if (document.hidden) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(tick);
      const reduced = !!reduceMq?.matches;
      const minGap = frameGap(now, reduced);
      if (minGap && now - last < minGap) return;
      // 降帧时一步走得更长：放宽 dt 上限，慢动作（呼吸、噪声）速度不变
      const dt = Math.min(Math.max(0.05, (minGap + 20) / 1000), (now - last) / 1000);
      last = now;
      const backend = backendRef.current;
      const canvas = canvasRef.current;
      if (!backend || !canvas) return;
      backend.update(dt, now / 1000);
      const frame = backend.snapshot();
      const userSig = `${frame.talking}|${frame.expression}|${frame.thinking}|${frame.lookX.toFixed(2)}|${frame.lookY.toFixed(2)}`;
      if (userSig !== lastUserSig || frame.mouth > 0.02) {
        lastUserSig = userSig;
        userAt = now;
      }
      const coreSig = `${frame.talking}|${frame.expression}|${frame.thinking}|${frame.gesture?.id}`;
      if (coreSig !== lastCoreSig || frame.mouth > 0.02) {
        lastCoreSig = coreSig;
        coreAt = now;
      }
      const lookSig = `${frame.lookX.toFixed(2)}|${frame.lookY.toFixed(2)}`;
      if (lookSig !== lastLookSig) {
        lastLookSig = lookSig;
        lookAt = now;
      }
      lastHot = frame.talking || frame.mouth > 0.02 || !!animRef.current?.actions.busy();
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      let resized = false;
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        resized = true;
      }
      const rig = rigRef.current;
      const anim = animRef.current;
      if (!rig || !anim) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
      }
      if (rig && anim) {
        // random idle behaviours (look around, hum, yawn, stretch …) — never while busy / reduced
        const pick = idleBehavior.update(now, {
          idleMs: now - userAt,
          busy: anim.actions.busy() || frame.talking || frame.thinking,
          hour: new Date().getHours(),
          reduced,
        });
        if (pick) backend.playMotion(pick, { priority: 0 });
        const pose = anim.step(dt, now / 1000, {
          expression: frame.expression,
          mouth: frame.mouth,
          talking: frame.talking,
          blink: frame.blinkOpacity,
          lookX: frame.lookX,
          lookY: frame.lookY,
          reducedMotion: reduced,
          gesture: frame.gesture,
          thinking: frame.thinking,
        });
        const box = characterBox(w, h);
        const view = rigTransform(rig, w, h, box);
        const cur = anim.actions.current() ?? '';
        if (resized) poseGate.invalidate();
        // 和上次画出的姿势几乎一样（静止 / 很慢的呼吸）：这一帧不重画，画布保持上一帧
        if (
          !poseGate.shouldPaint(
            pose,
            view.sc * dpr,
            `${w}x${h}@${dpr}|${box.x},${box.y},${box.w},${box.h}`,
          )
        ) {
          if (cur !== probeAction) {
            probeAction = cur;
            document.documentElement.dataset.mascotAction = cur;
          }
          return;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const t0 = performance.now();
        paintRigFrame(ctx, rig, rigImgs.current, pose, w, h, box);
        frameMs += (performance.now() - t0 - frameMs) * 0.1;
        if (cur !== probeAction || ++frameN % 30 === 0) {
          probeAction = cur;
          const ds = document.documentElement.dataset;
          ds.mascotAction = cur;
          ds.mascotPaintMs = frameMs.toFixed(2);
        }
        // canvas 固定铺满窗口，位置只在窗口移动/缩放时变；缓存避免每帧强制布局
        cachedRect ??= canvas.getBoundingClientRect();
        const r = cachedRect;
        const shift = (b: { left: number; right: number; top: number; bottom: number } | null) =>
          b && {
            left: b.left + r.left,
            right: b.right + r.left,
            top: b.top + r.top,
            bottom: b.bottom + r.top,
          };
        const bodyBox = shift(rigBodyBox(rig, rigImgs.current, view, w, h));
        const char = {
          left: r.left + box.x,
          right: r.left + box.x + box.w,
          top: r.top + box.y,
          bottom: r.top + box.y + box.h,
        };
        geometry.current = {
          head: shift(rigHeadBox(rig, rigImgs.current, pose, view)),
          body: bodyBox,
          box: char,
          paintSeq: ++paintSeq,
        };
        return;
      }
      const img = imgs.current.get(frame.expressionUrl);
      if (!img) return;
      const cb = characterBox(w, h);
      const scale = Math.min((cb.w * 0.85) / img.width, (cb.h * 0.9) / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      const lookOffX = frame.lookX * 8;
      const lookOffY = -frame.lookY * 6;
      const x = cb.x + (cb.w - dw) / 2 + lookOffX;
      const y = cb.y + (cb.h - dh) / 2 + frame.bobY + lookOffY;
      cachedRect ??= canvas.getBoundingClientRect();
      const sr = cachedRect;
      geometry.current = {
        head: { left: x, right: x + dw, top: y, bottom: y + dh * 0.4 },
        body: { left: x, right: x + dw, top: y, bottom: y + dh },
        box: {
          left: sr.left + cb.x,
          right: sr.left + cb.x + cb.w,
          top: sr.top + cb.y,
          bottom: sr.top + cb.y + cb.h,
        },
      };
      if (styleKindRef.current === 'pixel') {
        ctx.imageSmoothingEnabled = false;
      } else {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
      }
      ctx.drawImage(img, x, y, dw, dh);
      if (frame.blinkOpacity > 0.01 && backend.manifest.blink) {
        const b = imgs.current.get(
          `${backend.baseUrl}${backend.manifest.blink}`.replace(/([^:]\/)\/+/g, '$1'),
        );
        // resolve blink url same as snapshot
        const blinkUrl = frame.expressionUrl.replace(/[^/]+$/, backend.manifest.blink!);
        const blinkImg = imgs.current.get(blinkUrl) ?? b;
        if (blinkImg) {
          ctx.globalAlpha = frame.blinkOpacity;
          ctx.drawImage(blinkImg, x, y, dw, dh);
          ctx.globalAlpha = 1;
        }
      }
      if (frame.mouthOpacity > 0.02 && frame.mouthUrl) {
        const m = imgs.current.get(frame.mouthUrl);
        if (m) {
          ctx.globalAlpha = frame.mouthOpacity;
          ctx.drawImage(m, x, y, dw, dh);
          ctx.globalAlpha = 1;
        }
      }
    };
    raf = requestAnimationFrame(tick);
    let greeted = false;
    const tryGreet = () => {
      const b = backendRef.current;
      if (!b || !rigRef.current || greeted) return;
      // first open / return-from-hidden: a soft greet nod-wave
      b.playMotion('greet');
      greeted = true;
    };
    // greet shortly after the rig finishes loading
    const greetTimer = window.setTimeout(tryGreet, 900);
    let visTimer = 0;
    const onVis = () => {
      if (!document.hidden && !raf && !cancelled) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
        // re-arm a greet when returning from a long hide
        if (greeted) greeted = false;
        window.clearTimeout(visTimer);
        visTimer = window.setTimeout(tryGreet, 400);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('resize', onResize);

    // Map 本身从不重新赋值；清理时用 effect 内取的引用，避免「cleanup 时 ref 已变」的歧义
    const loadedImgs = imgs.current;
    const loadedRigImgs = rigImgs.current;
    return () => {
      cancelled = true;
      window.clearTimeout(greetTimer);
      window.clearTimeout(visTimer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
      detach?.();
      backendRef.current?.dispose();
      backendRef.current = null;
      releaseImages(loadedImgs);
      releaseImages(loadedRigImgs);
      runtime.flag('mascotRig');
    };
    // mark / debugHandles are stable per stage; the rig only reloads when its manifest changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestPath]);

  return (
    <div
      className={className}
      data-testid="sprite-canvas"
      data-sprite-style={styleKind}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        background: transparent ? 'transparent' : '#1e2430',
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          imageRendering: styleKind === 'pixel' ? 'pixelated' : 'auto',
        }}
      />
      {ready && (
        <MascotInteractionLayerLite
          canvasRef={canvasRef}
          geometry={geometry}
          registry={runtime.registry}
        />
      )}
      {!ready && !error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#ccc',
            fontSize: 13,
          }}
        >
          Loading 2D sprite…
        </div>
      )}
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
          Sprite error: {error}
        </div>
      )}
    </div>
  );
};

export default SpriteCanvas;
