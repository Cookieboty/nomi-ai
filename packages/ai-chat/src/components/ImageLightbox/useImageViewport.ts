import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

const INITIAL_VIEW = { zoom: 1, x: 0, y: 0 };
const clampZoom = (zoom: number) => Math.max(0.25, Math.min(4, zoom));
interface GestureEvent extends Event {
  scale: number;
  clientX?: number;
  clientY?: number;
}

/** Shared image transforms for both viewers; the stage centers the untransformed image. */
export function useImageViewport(enabled: boolean) {
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(INITIAL_VIEW);
  const current = useRef(INITIAL_VIEW);
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number } | null>(
    null,
  );
  const update = useCallback((next: typeof INITIAL_VIEW) => {
    current.current = next;
    setView(next);
  }, []);
  const reset = useCallback(() => {
    drag.current = null;
    update(INITIAL_VIEW);
  }, [update]);
  const changeZoom = (next: number) => {
    drag.current = null;
    const zoom = clampZoom(next);
    update({ ...current.current, zoom, ...(zoom <= 1 ? { x: 0, y: 0 } : {}) });
  };

  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    let gestureScale: number | null = null;
    const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
      if (!enabled || !Number.isFinite(factor) || factor <= 0) return;
      const previous = current.current;
      const zoom = clampZoom(previous.zoom * factor);
      if (zoom === previous.zoom) return;
      const rect = host.getBoundingClientRect();
      const x =
        (clientX ?? cursor.current?.x ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
      const y =
        (clientY ?? cursor.current?.y ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
      const ratio = zoom / previous.zoom;
      drag.current = null;
      // Keep the image point under the cursor fixed, even across zooms below 100% or rapid events.
      update({ zoom, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio });
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (gestureScale !== null || !Number.isFinite(event.deltaY)) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1;
      const delta = Math.max(-100, Math.min(100, event.deltaY * unit));
      zoomAt(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), event.clientX, event.clientY);
    };
    const start = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const scale = (event as GestureEvent).scale;
      gestureScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    };
    const change = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const { scale, clientX, clientY } = event as GestureEvent;
      if (gestureScale === null || !Number.isFinite(scale) || scale <= 0) return;
      zoomAt(scale / gestureScale, clientX, clientY);
      gestureScale = scale;
    };
    const end = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      gestureScale = null;
    };
    const move = (event: globalThis.PointerEvent) => {
      cursor.current = { x: event.clientX, y: event.clientY };
    };
    host.addEventListener('pointermove', move, { passive: true });
    // Native non-passive listeners can cancel browser page zoom, including WebKit pinch gestures.
    host.addEventListener('wheel', wheel, { passive: false });
    host.addEventListener('gesturestart', start, { passive: false });
    host.addEventListener('gesturechange', change, { passive: false });
    host.addEventListener('gestureend', end, { passive: false });
    return () => {
      host.removeEventListener('pointermove', move);
      host.removeEventListener('wheel', wheel);
      host.removeEventListener('gesturestart', start);
      host.removeEventListener('gesturechange', change);
      host.removeEventListener('gestureend', end);
    };
  }, [enabled, update]);

  const endDrag = () => {
    drag.current = null;
  };
  return {
    stage,
    zoom: view.zoom,
    offset: { x: view.x, y: view.y },
    changeZoom,
    reset,
    imageEvents: {
      onDoubleClick: reset,
      onPointerDown: (event: PointerEvent<HTMLImageElement>) => {
        const position = current.current;
        if (
          !enabled ||
          event.button !== 0 ||
          (position.zoom <= 1 && position.x === 0 && position.y === 0)
        )
          return;
        event.preventDefault();
        drag.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          startX: position.x,
          startY: position.y,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      },
      onPointerMove: (event: PointerEvent<HTMLImageElement>) => {
        const origin = drag.current;
        if (!origin || origin.id !== event.pointerId) return;
        update({
          ...current.current,
          x: origin.startX + event.clientX - origin.x,
          y: origin.startY + event.clientY - origin.y,
        });
      },
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
    },
  };
}
