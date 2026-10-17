import { useEffect } from 'react';
import type { FC, RefObject } from 'react';

import { ClickClassifier, PatDetector } from '../../mascot/interaction/gestures';
import {
  DragGate,
  HitHysteresis,
  hitRadius,
  inPaddedRects,
} from '../../mascot/interaction/pointerPolicy';
import { react } from '../../mascot/interaction/reactions';
import type { BodyRegion } from '../../mascot/interaction/regions';
import { interactionSettings } from '../../mascot/interaction/settings';
import { alphaSpans, rectsKey, type Rect } from '../../mascot/interaction/shape';
import { layoutStore, type Box } from '../../mascot/layoutStore';
import { regionInSprite, type MascotRegistryLike } from '../../mascot/spriteInteraction';
import { onWindowResized } from '../../mascot/windowResize';

const ALPHA_HIT = 24;
const UI_PAD = 16;
const HOVER_DWELL_MS = 600;

/** Latest sprite geometry, written by SpriteCanvas every frame (CSS px, window coords). */
export interface SpriteGeometry {
  head: Box | null;
  body: Box | null;
}

export interface InteractionLiteProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  geometry: RefObject<SpriteGeometry>;
  registry: MascotRegistryLike;
}

/**
 * Desktop interaction for the 2D sprite / layered rig (same contract as the 3D
 * MascotInteractionLayer, without three.js):
 * - per-pixel hit test on the 2D canvas alpha (+ mascot UI) → main toggles click-through
 *   (Windows / macOS: setIgnoreMouseEvents forward; Linux: window shape)
 * - press + move → window drag through the main process (mascot:drag-*), pointer captured so
 *   the drag keeps tracking while the window moves; a plain click / double-click still reacts
 * - head / body boxes → layoutStore (speech bubble avoids the face, toolbar slot) + physics box
 * - look-at follows the global cursor relative to the head
 */
const InteractionLite: FC<InteractionLiteProps> = ({ canvasRef, geometry, registry }) => {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const api = window.electronAPI?.mascotWindow;
    interactionSettings.push();
    const gate = new DragGate();
    const hyst = new HitHysteresis(120);
    const pat = new PatDetector();
    const classifier = new ClickClassifier((region, kind) => react(kind, region));
    const s = {
      cursor: { x: -1e6, y: -1e6, inside: false, fresh: false },
      hit: null as boolean | null,
      down: null as { region: BodyRegion; sx: number; sy: number } | null,
      /** true between our pointerdown and pointerup/mouseup — Playwright on Windows
       *  often reports e.buttons=0 on move even while the button is held. */
      buttonHeld: false,
      dragging: false,
      hover: null as BodyRegion | null,
      hoverSince: 0,
      hoverFired: false,
      lastGeom: '',
      lastShape: '',
      geomAt: 0,
      shapeAt: 0,
    };
    let ctx2d: CanvasRenderingContext2D | null = null;
    let tainted = false;
    const ctx = () => (ctx2d ??= canvas.getContext('2d'));

    const alphaAt = (x: number, y: number, rad: number): number => {
      const r = canvas.getBoundingClientRect();
      const g = ctx();
      if (!g || r.width <= 0) return 0;
      const k = canvas.width / r.width;
      const px = Math.round((x - r.left) * k);
      const py = Math.round((y - r.top) * k);
      const n = Math.max(0, Math.round(rad * k));
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return 0;
      try {
        const x0 = Math.max(0, px - n);
        const y0 = Math.max(0, py - n);
        const w = Math.min(canvas.width - x0, 2 * n + 1);
        const h = Math.min(canvas.height - y0, 2 * n + 1);
        const d = g.getImageData(x0, y0, w, h).data;
        let a = 0;
        for (let i = 3; i < d.length; i += 4) a = Math.max(a, d[i]);
        return a;
      } catch {
        tainted = true; // cross-origin pixels: fall back to the geometric silhouette
        return -1;
      }
    };

    const uiRects = () => {
      const out: Box[] = [];
      document.querySelectorAll<HTMLElement>('[data-mascot-ui]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return;
        out.push(r);
      });
      return out;
    };

    const geomHit = (x: number, y: number): boolean => {
      const { head, body } = geometry.current ?? { head: null, body: null };
      const inBox = (b: Box | null) =>
        !!b && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
      return inBox(head) || inBox(body);
    };

    const hitTest = (x: number, y: number, currentlyHit: boolean): boolean => {
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
      const el = document.elementFromPoint(x, y);
      if (el && el !== canvas && !el.contains(canvas)) return true;
      if (inPaddedRects(x, y, uiRects(), UI_PAD)) return true;
      if (tainted) return geomHit(x, y);
      const a = alphaAt(x, y, hitRadius(currentlyHit));
      // Rive's canvas may be GPU-backed or transparent even while the scene is
      // visible, so its pixels are not a reliable hit-test source. Use the
      // measured character geometry for that backend and keep alpha testing for
      // the legacy sprite renderer.
      const kind = (registry.current() as { kind?: string } | null)?.kind;
      if (kind === 'rive') return geomHit(x, y);
      return a < 0 ? geomHit(x, y) : a >= ALPHA_HIT;
    };

    const regionAt = (x: number, y: number): BodyRegion => {
      const g = geometry.current;
      return regionInSprite(x, y, g?.head ?? null, g?.body ?? null);
    };

    const offCursor = api?.onCursor((p) => {
      s.cursor = { x: p.x, y: p.y, inside: p.inside, fresh: true };
      layoutStore.setCursor({ x: p.x, y: p.y, inside: p.inside });
    });

    const offEvt = api?.onPhysicsEvent((e) => {
      document.documentElement.dataset.mascotPhysics = e.type;
      if (e.type === 'grab') react('grab', 'any', 3000);
      else if (e.type === 'land' && e.speed > 900) react('land', 'any', 4000);
      else if (e.type === 'wall' && e.speed > 900) react('wall', 'any', 3000);
    });

    const endDrag = (why: string) => {
      document.documentElement.dataset.mascotDragEnd = why;
      api?.dragEnd();
      s.dragging = false;
      document.documentElement.dataset.mascotDragging = '0';
    };
    const onMove = (e: PointerEvent | MouseEvent) => {
      s.cursor = { x: e.clientX, y: e.clientY, inside: true, fresh: true };
      // Prefer our own held flag: under setPointerCapture / click-through toggles,
      // Chromium on Windows frequently delivers move events with buttons=0.
      const buttons = s.buttonHeld ? e.buttons | 1 : e.buttons;
      if (s.dragging && buttons & 1) api?.dragMove(e.screenX, e.screenY);
      const r = gate.move(e.clientX, e.clientY, performance.now(), buttons);
      if (r === 'start' && s.down) {
        s.dragging = true;
        api?.dragStart(s.down.sx, s.down.sy);
        api?.dragMove(e.screenX, e.screenY);
        document.documentElement.dataset.mascotDragging = '1';
      } else if (r === 'cancel' || (!gate.isDown && s.down && !s.buttonHeld)) {
        // button released without a pointerup (lost during a click-through toggle)
        if (s.dragging) endDrag('buttons');
        s.down = null;
      }
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.target !== canvas) return;
      if (!hitTest(e.clientX, e.clientY, true)) return;
      s.buttonHeld = true;
      gate.press(e.clientX, e.clientY, performance.now());
      s.down = { region: regionAt(e.clientX, e.clientY), sx: e.screenX, sy: e.screenY };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic event without a real pointer */
      }
    };
    const finish = (click: boolean, why = 'up') => {
      s.buttonHeld = false;
      const r = gate.release();
      if (s.dragging) endDrag(why);
      else if (click && r === 'click' && s.down) classifier.click(s.down.region);
      s.down = null;
    };
    const onUp = (e: PointerEvent) => {
      if (e.button === 0) finish(true);
    };
    // While the main process is moving the window, Windows can report blur / pointercancel /
    // lost capture as the window slides under the cursor. Keep dragging then: the drag ends on
    // pointerup, or on the next move without the button held (DragGate 'cancel').
    const onCancel = (e: Event) => {
      if (s.dragging) {
        document.documentElement.dataset.mascotDragIgnored = e.type;
        return;
      }
      gate.cancel();
      finish(false, e.type);
    };
    const onMouseUp = (e: MouseEvent) => {
      // pointerup can be swallowed after a lost capture; the compat mouseup still arrives
      if (e.button === 0 && (s.dragging || s.down)) finish(true, 'mouseup');
    };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);

    let raf = 0;
    let headAt = 0;
    // 窗口被缩放：尽快重新上报包围盒 / 头部框 / 形状（见 windowResize.ts）
    const offResize = onWindowResized(() => {
      s.geomAt = 0;
      s.shapeAt = 0;
      s.lastGeom = '';
      headAt = 0;
    });
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const g = geometry.current;
      const cfg = interactionSettings.get();
      // head box (bubble placement), ≈12 Hz
      if (g?.head && now - headAt > 80) {
        headAt = now;
        const h = {
          left: Math.round(g.head.left),
          right: Math.round(g.head.right),
          top: Math.round(g.head.top),
          bottom: Math.round(g.head.bottom),
        };
        layoutStore.setHead(h);
        document.documentElement.dataset.mascotHead = `${h.left},${h.right},${h.top},${h.bottom}`;
      }
      // body box (toolbar slot + main-process physics), 2 Hz with 8 px hysteresis
      if (g?.body && now - s.geomAt > 500) {
        s.geomAt = now;
        const box = {
          left: Math.round(g.body.left),
          right: Math.round(g.body.right),
          top: Math.round(g.body.top),
          bottom: Math.round(g.body.bottom),
        };
        layoutStore.setBox(box);
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
          s.lastGeom = `${box.left},${box.right},${box.top},${box.bottom}`;
          api?.setGeometry(box);
          document.documentElement.dataset.mascotBox = s.lastGeom;
        }
      }
      // look-at relative to the head
      const b = registry.current();
      const c = s.cursor;
      if (b && g?.head) {
        if (s.dragging) b.lookAt(0, 0);
        else if ((cfg.globalLook || c.inside) && c.x > -1e5) {
          const hx = (g.head.left + g.head.right) / 2;
          const hy = (g.head.top + g.head.bottom) / 2;
          b.lookAt(
            Math.max(-1, Math.min(1, (c.x - hx) / 280)),
            Math.max(-1, Math.min(1, -(c.y - hy) / 280)),
          );
        } else if (!c.inside) b.lookAt(0, 0);
      }
      // Linux: window shape = alpha scanlines + UI rects (≈4 Hz)
      if (api?.platform === 'linux' && now - s.shapeAt > 250 && !s.dragging) {
        s.shapeAt = now;
        let rects: Rect[] = [];
        const cx = ctx();
        if (cfg.clickThrough && cx && !document.querySelector('[role="dialog"]')) {
          const r = canvas.getBoundingClientRect();
          try {
            const img = cx.getImageData(0, 0, canvas.width, canvas.height);
            rects = alphaSpans(new Uint8Array(img.data.buffer), canvas.width, canvas.height, {
              scale: r.width / Math.max(1, canvas.width),
              offsetX: r.left,
              offsetY: r.top,
              topDown: true,
            });
          } catch {
            const bb = g?.body;
            rects = bb
              ? [{ x: bb.left, y: bb.top, width: bb.right - bb.left, height: bb.bottom - bb.top }]
              : [];
          }
          if (rects.length) {
            for (const u of uiRects())
              rects.push({
                x: u.left - 4,
                y: u.top - 4,
                width: u.right - u.left + 8,
                height: u.bottom - u.top + 8,
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
      c.fresh = false;
      // hit → click-through (held / dragging always interactive)
      const t = performance.now();
      const raw = s.dragging || !!s.down || hitTest(c.x, c.y, hyst.value);
      const eff = hyst.feed(raw, t);
      if (eff !== s.hit) {
        s.hit = eff;
        api?.setHit(eff);
        document.documentElement.dataset.mascotHit = eff ? '1' : '0';
      }
      // hover / pat reactions
      const region = raw && !s.dragging && !s.down ? regionAt(c.x, c.y) : null;
      if (region !== s.hover) {
        s.hover = region;
        s.hoverSince = t;
        s.hoverFired = false;
        pat.reset();
        document.documentElement.dataset.mascotHover = region ?? '';
      }
      if (region && !s.hoverFired && t - s.hoverSince >= HOVER_DWELL_MS) {
        s.hoverFired = true;
        react('hover', region, 20000);
      }
      if (region === 'head' && pat.feed(c.x, t)) react('pat', 'head', 1500);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      offResize();
      offCursor?.();
      offEvt?.();
      classifier.dispose();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('lostpointercapture', onCancel);
      if (s.dragging) api?.dragEnd();
      layoutStore.setHead(null);
    };
  }, [canvasRef, geometry, registry]);
  return null;
};

export default InteractionLite;
