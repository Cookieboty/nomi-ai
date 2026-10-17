import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { FC } from 'react';
import * as THREE from 'three';

import type { VrmBackend } from '../backends/vrm';
import { layoutStore } from '../layoutStore';
import { mascotRegistry } from '../MascotBackend';
import { onWindowResized } from '../windowResize';

import { ClickClassifier, PatDetector } from './gestures';
import { DragGate, HitHysteresis, hitRadius, inPaddedRects } from './pointerPolicy';
import { react } from './reactions';
import { pickRegion, type BodyRegion } from './regions';
import { interactionSettings } from './settings';
import { alphaSpans, rectsKey, type Rect } from './shape';

const ALPHA_HIT = 24; // 0..255
/** UI（工具栏 / 气泡 / 卡片）四周这么宽的一圈也算命中：边缘不会点穿 */
const UI_PAD = 16;
/** 悬停需停留这么久才触发悬停反应 */
const HOVER_DWELL_MS = 600;
const SAMPLE = 21; // alpha 采样窗口边长（覆盖最大膨胀半径 10）
/** readPixels 同步回读很贵：光标命中测试最多 ~30Hz，帧间复用上一次结果 */
const HIT_MIN_GAP_S = 1 / 30;
/** canvas 包围盒 / UI 矩形缓存有效期（缩放 / 布局变化时最多延迟这点时间生效） */
const RECT_TTL_MS = 250;
const UI_RECT_TTL_MS = 150;

function vrmBackend(): VrmBackend | null {
  const b = mascotRegistry.current() as VrmBackend | null;
  return b && typeof b.colliders === 'function' ? b : null;
}

/** canvas 包围盒带 TTL 缓存（每帧 getBoundingClientRect 会强制同步布局） */
interface RectCache {
  rect: DOMRect | null;
  at: number;
}
function getCachedRect(cache: RectCache, canvas: HTMLCanvasElement): DOMRect {
  const now = performance.now();
  if (!cache.rect || now - cache.at > RECT_TTL_MS) {
    cache.rect = canvas.getBoundingClientRect();
    cache.at = now;
  }
  return cache.rect;
}

/** 可见看板娘 UI 矩形，带短 TTL 缓存（querySelectorAll + getComputedStyle 很重） */
interface UiRectCache {
  rects: DOMRect[];
  at: number;
}
function getCachedUiRects(cache: UiRectCache): DOMRect[] {
  const now = performance.now();
  if (now - cache.at > UI_RECT_TTL_MS) {
    const out: DOMRect[] = [];
    document.querySelectorAll<HTMLElement>('[data-mascot-ui]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return;
      out.push(r);
    });
    cache.rects = out;
    cache.at = now;
  }
  return cache.rects;
}

/**
 * 看板娘桌面互动（位于 R3F Canvas 内）：
 * - 逐像素命中：读取画布 alpha（+ 骨骼碰撞体兜底），UI 元素视为命中 → 主进程切换点击穿透
 * - 区域悬停 / 摸头 / 单击 / 双击反应；全局光标视线跟随
 * - 按住拖动窗口（主进程移动窗口并估计速度，松手抛出）
 * - 上报角色在窗口内的包围盒（主进程以此判定落地 / 撞墙）
 */
const MascotInteractionLayer: FC = () => {
  const { camera, gl } = useThree();
  const st = useRef({
    cursor: { x: -1, y: -1, inside: false, fresh: false },
    hit: null as boolean | null,
    hover: null as BodyRegion | null,
    hoverSince: 0,
    hoverFired: false,
    down: null as {
      x: number;
      y: number;
      sx: number;
      sy: number;
      region: BodyRegion | null;
    } | null,
    buttonHeld: false,
    dragging: false,
    lastGeom: '',
    geomAt: 0,
    headAt: 0,
    shapeAt: 0,
    lastShape: '',
    hitAt: -1e9,
  });
  /** canvas 包围盒缓存（窗口缩放 / 角色缩放时 TTL 内自动失效） */
  const rectCache = useRef<RectCache>({ rect: null, at: 0 });
  /** UI 矩形缓存（querySelectorAll + getComputedStyle 很重，不能每帧/每光标事件跑） */
  const uiCache = useRef<UiRectCache>({ rects: [], at: 0 });

  const getCanvasRect = () => getCachedRect(rectCache.current, canvas);
  const getUiRects = () => getCachedUiRects(uiCache.current);
  const ray = useRef(new THREE.Raycaster());
  const ndc = useRef(new THREE.Vector2());
  const pat = useRef(new PatDetector());
  const pixel = useRef(new Uint8Array(4 * SAMPLE * SAMPLE));
  const gate = useRef(new DragGate());
  const hyst = useRef(new HitHysteresis(120));
  const shapeBuf = useRef(new Uint8Array(0));

  const canvas = gl.domElement;

  /** 窗口坐标 → 区域（射线 vs 骨骼碰撞体） */
  const pickAt = (x: number, y: number): BodyRegion | null => {
    const b = vrmBackend();
    if (!b) return null;
    const r = getCanvasRect();
    if (r.width <= 0 || r.height <= 0) return null;
    ndc.current.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.current.setFromCamera(ndc.current, camera);
    const { origin, direction } = ray.current.ray;
    return pickRegion(origin, direction, b.colliders())?.region ?? null;
  };

  /** 画布在 (x, y) 附近 (2·rad+1)² 像素内的最大 alpha（膨胀轮廓，抗锯齿边缘也算） */
  const alphaAt = (x: number, y: number, rad = 2): number => {
    const r = getCanvasRect();
    const ctx = gl.getContext();
    const sx = canvas.width / Math.max(1, r.width);
    const sy = canvas.height / Math.max(1, r.height);
    const px = Math.round((x - r.left) * sx);
    const py = Math.round(canvas.height - (y - r.top) * sy);
    const k = Math.max(0, Math.min((SAMPLE - 1) / 2, Math.round(rad * sx)));
    const n = 2 * k + 1;
    if (px < k || py < k || px >= canvas.width - k || py >= canvas.height - k) return 0;
    try {
      ctx.readPixels(px - k, py - k, n, n, ctx.RGBA, ctx.UNSIGNED_BYTE, pixel.current);
    } catch {
      return 0;
    }
    let a = 0;
    for (let i = 3; i < n * n * 4; i += 4) a = Math.max(a, pixel.current[i]);
    return a;
  };

  const hitTest = (x: number, y: number, currentlyHit = false): boolean => {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
    const el = document.elementFromPoint(x, y);
    // 工具栏 / 气泡 / 弹窗等 UI：不是画布本身、也不是画布的祖先容器
    if (el && el !== canvas && !el.contains(canvas)) return true;
    if (inPaddedRects(x, y, getUiRects(), UI_PAD)) return true;
    return alphaAt(x, y, hitRadius(currentlyHit)) >= ALPHA_HIT || pickAt(x, y) !== null;
  };

  useEffect(() => {
    const s = st.current;
    const api = window.electronAPI?.mascotWindow;
    interactionSettings.push();
    const classifier = new ClickClassifier((region, kind) => react(kind, region));
    // 窗口被缩放：尽快重新上报包围盒（见 windowResize.ts），并失效矩形缓存
    const offResize = onWindowResized(() => {
      s.geomAt = -1e9;
      s.lastGeom = '';
      rectCache.current.at = 0;
      uiCache.current.at = 0;
    });

    const offCursor = api?.onCursor((p) => {
      s.cursor = { x: p.x, y: p.y, inside: p.inside, fresh: true };
      layoutStore.setCursor({ x: p.x, y: p.y, inside: p.inside });
    });
    const offBody = api?.onBody((m) => vrmBackend()?.setBodyMotion(m));
    const offEvt = api?.onPhysicsEvent((e) => {
      const b = vrmBackend();
      document.documentElement.dataset.mascotPhysics = e.type;
      if (e.type === 'land' || e.type === 'bounce') {
        if (e.speed > 250) b?.land(e.speed);
        if (e.type === 'land' && e.speed > 900) react('land', 'any', 4000);
      } else if (e.type === 'grab') {
        react('grab', 'any', 3000);
      } else if (e.type === 'wall' && e.speed > 900) {
        react('wall', 'any', 3000);
      }
    });

    const endDrag = () => {
      api?.dragEnd();
      s.dragging = false;
      document.documentElement.dataset.mascotDragging = '0';
    };
    const onMove = (e: PointerEvent | MouseEvent) => {
      s.cursor = { x: e.clientX, y: e.clientY, inside: true, fresh: true };
      const buttons = s.buttonHeld ? e.buttons | 1 : e.buttons;
      if (s.dragging && buttons & 1) api?.dragMove(e.screenX, e.screenY);
      const r = gate.current.move(e.clientX, e.clientY, performance.now(), buttons);
      if (r === 'start' && s.down) {
        s.dragging = true;
        api?.dragStart(s.down.sx, s.down.sy);
        api?.dragMove(e.screenX, e.screenY);
        document.documentElement.dataset.mascotDragging = '1';
      } else if (r === 'cancel' || (!gate.current.isDown && s.down && !s.buttonHeld)) {
        // 按键已松开却没收到 pointerup（点击穿透切换时可能丢）：结束，不算点击
        if (s.dragging) endDrag();
        s.down = null;
      }
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.target !== canvas) return;
      if (!hitTest(e.clientX, e.clientY, true)) return;
      s.buttonHeld = true;
      gate.current.press(e.clientX, e.clientY, performance.now());
      s.down = {
        x: e.clientX,
        y: e.clientY,
        sx: e.screenX,
        sy: e.screenY,
        region: pickAt(e.clientX, e.clientY),
      };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* 合成事件没有真实指针 */
      }
    };
    const finish = (click: boolean) => {
      s.buttonHeld = false;
      const r = gate.current.release();
      if (s.dragging) endDrag();
      else if (click && r === 'click' && s.down) classifier.click(s.down.region ?? 'body');
      s.down = null;
    };
    const onUp = (e: PointerEvent) => {
      if (e.button === 0) finish(true);
    };
    const onCancel = () => {
      gate.current.cancel();
      finish(false);
    };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    return () => {
      offResize();
      offCursor?.();
      offBody?.();
      offEvt?.();
      classifier.dispose();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      if (s.dragging) api?.dragEnd();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- canvas / camera 在画布生命周期内不变
  }, [canvas]);

  const tmp = useRef(new THREE.Vector3());

  useFrame((state) => {
    const s = st.current;
    const b = vrmBackend();
    const api = window.electronAPI?.mascotWindow;
    if (!b) return;
    const cfg = interactionSettings.get();
    const now = state.clock.elapsedTime;
    const rect = getCanvasRect();
    const toScreen = (p: { x: number; y: number; z: number }) => {
      tmp.current.set(p.x, p.y, p.z).project(camera);
      return {
        x: rect.left + ((tmp.current.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - tmp.current.y) / 2) * rect.height,
      };
    };

    // ---- 头部 / 脸矩形（气泡避让用，≈12Hz）----
    if (now - s.headAt > 0.08) {
      s.headAt = now;
      let l = Infinity;
      let r = -Infinity;
      let t = Infinity;
      let btm = -Infinity;
      for (const c of b.colliders()) {
        if (c.region !== 'face' && c.region !== 'head') continue;
        const p = toScreen(c.center);
        const edge = toScreen({ x: c.center.x + c.radius, y: c.center.y, z: c.center.z });
        const rad = Math.abs(edge.x - p.x);
        l = Math.min(l, p.x - rad);
        r = Math.max(r, p.x + rad);
        t = Math.min(t, p.y - rad);
        btm = Math.max(btm, p.y + rad);
      }
      if (Number.isFinite(l)) {
        // 外扩 8%，把发梢 / 呼吸摆动也算进去
        const pad = (r - l) * 0.08;
        const head = {
          left: Math.round(l - pad),
          right: Math.round(r + pad),
          top: Math.round(t - pad),
          bottom: Math.round(btm + pad),
        };
        layoutStore.setHead(head);
        document.documentElement.dataset.mascotHead = `${head.left},${head.right},${head.top},${head.bottom}`;
      }
    }

    // ---- 包围盒上报（主进程物理用）----
    if (now - s.geomAt > 0.5) {
      s.geomAt = now;
      let l = Infinity;
      let r = -Infinity;
      let t = Infinity;
      let btm = -Infinity;
      const cols = b.colliders();
      for (const c of cols) {
        const p = toScreen(c.center);
        const edge = toScreen({ x: c.center.x + c.radius, y: c.center.y, z: c.center.z });
        const rad = Math.abs(edge.x - p.x);
        l = Math.min(l, p.x - rad);
        r = Math.max(r, p.x + rad);
        t = Math.min(t, p.y - rad);
        btm = Math.max(btm, p.y + rad * 0.4); // 脚底：脚骨球体下沿附近
      }
      if (cols.length && Number.isFinite(l)) {
        const box = {
          left: Math.round(Math.max(0, l)),
          right: Math.round(Math.min(window.innerWidth, r)),
          top: Math.round(Math.max(0, t)),
          bottom: Math.round(Math.min(window.innerHeight, btm)),
        };
        layoutStore.setBox(box);
        const key = `${box.left},${box.right},${box.top},${box.bottom}`;
        // 滞回：待机动画会让包围盒每帧微动，只有变化 ≥ 8px 才上报，避免窗口跟着抖
        const prev = s.lastGeom ? s.lastGeom.split(',').map(Number) : null;
        const changed =
          !prev ||
          Math.max(
            Math.abs(prev[0] - box.left),
            Math.abs(prev[1] - box.right),
            Math.abs(prev[2] - box.top),
            Math.abs(prev[3] - box.bottom),
          ) >= 8;
        if (changed && !s.dragging && !s.down) {
          s.lastGeom = key;
          api?.setGeometry(box);
          document.documentElement.dataset.mascotBox = key;
        }
      }
    }

    const c = s.cursor;
    // ---- 视线：全局光标（或窗口内光标）相对头部 ----
    // 拖拽中收回正视，避免窗口移动与视线弹簧叠出抖动
    const headW = b.headWorld();
    if (s.dragging) {
      b.lookAt(0, 0);
    } else if (headW && (cfg.globalLook || c.inside) && c.x > -1e5) {
      const h = toScreen(headW);
      const dx = c.x - h.x;
      const dy = c.y - h.y;
      // 更深的假想视距 → 更小偏转，细微光标抖动不那么明显
      b.lookAt(Math.max(-1, Math.min(1, dx / 560)), Math.max(-1, Math.min(1, -dy / 560)));
    } else if (!cfg.globalLook && !c.inside) {
      b.lookAt(0, 0);
    }

    // ---- Linux：窗口形状 = 角色 alpha 扫描线 + UI 矩形（≈4Hz）----
    if (api?.platform === 'linux' && now - s.shapeAt > 0.25 && !s.dragging) {
      s.shapeAt = now;
      let rects: Rect[] = [];
      if (cfg.clickThrough && !document.querySelector('[role="dialog"]')) {
        const ctx = gl.getContext();
        const w = canvas.width;
        const h = canvas.height;
        if (shapeBuf.current.length !== w * h * 4) shapeBuf.current = new Uint8Array(w * h * 4);
        try {
          ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, shapeBuf.current);
          rects = alphaSpans(shapeBuf.current, w, h, {
            scale: rect.width / Math.max(1, w),
            offsetX: rect.left,
            offsetY: rect.top,
          });
        } catch {
          rects = [];
        }
        if (rects.length) {
          document.querySelectorAll<HTMLElement>('[data-mascot-ui]').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0)
              rects.push({ x: r.left - 4, y: r.top - 4, width: r.width + 8, height: r.height + 8 });
          });
        }
      }
      const key = rectsKey(rects);
      if (key !== s.lastShape) {
        s.lastShape = key;
        api.setShape(rects);
      }
    }

    if (!c.fresh) return;

    // 命中测试含 readPixels 同步回读，限到 ~30Hz；帧间保留 fresh 等下个间隔再算。
    // 拖拽 / 按住期间不节流，保证起拖与点击穿透切换即时。
    const forced = s.dragging || !!s.down;
    if (!forced && now - s.hitAt < HIT_MIN_GAP_S) return;
    s.hitAt = now;
    c.fresh = false;

    // ---- 命中测试 → 点击穿透（膨胀轮廓 + 120ms 离开去抖；按住期间始终可交互）----
    const nowMs = performance.now();
    const hit = forced || hitTest(c.x, c.y, hyst.current.value);
    const effective = hyst.current.feed(hit, nowMs);
    if (effective !== s.hit) {
      s.hit = effective;
      api?.setHit(effective);
      document.documentElement.dataset.mascotHit = effective ? '1' : '0';
    }

    // ---- 区域悬停 / 摸头 ----
    const region = hit && !s.dragging ? pickAt(c.x, c.y) : null;
    if (region !== s.hover) {
      s.hover = region;
      s.hoverSince = nowMs;
      s.hoverFired = false;
      pat.current.reset();
      document.documentElement.dataset.mascotHover = region ?? '';
    }
    // 悬停只换表情 / 说句话，从不移动她；需停留一会儿，且有较长冷却
    if (region && !s.hoverFired && !s.down && nowMs - s.hoverSince >= HOVER_DWELL_MS) {
      s.hoverFired = true;
      react('hover', region, 20000);
    }
    if (region === 'head' && pat.current.feed(c.x, performance.now())) react('pat', 'head', 1500);
  });

  return null;
};

export default MascotInteractionLayer;
