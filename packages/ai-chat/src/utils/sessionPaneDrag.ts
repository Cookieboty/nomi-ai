/**
 * 从侧栏会话行拖进主区分屏的轻量 Pointer 控制器：
 * - 避免 HTML5 native drag 在 WKWebView / WebView2 的 `<button>` 上不稳定及与文件拖入冲突；
 * - 位移超过阈值（6px）才激活拖拽，轻点照常走 `onClick`；激活后自动拦截松手紧随的 `click`；
 * - 拖动过程只在独立 store 中更新坐标与命中侧，只有幽灵卡片与高亮落区重渲染，不惊动整个 App / Sidebar。
 */
import { useSyncExternalStore } from 'react';

import type { SessionPaneSide } from './sessionPanes';

export const SESSION_DRAG_THRESHOLD_PX = 6;

export interface ActiveSessionDrag {
  /** 正在拖动的会话行 id */
  id: string;
  /** 会话键（nomi:<id> / cli:<backend>:<id> / tab:<id>） */
  sessionKey: string;
  /** 幽灵卡片显示的会话标题 */
  title: string;
  x: number;
  y: number;
  /** 当前光标命中的合法分屏侧；未在主区或不可放置时为 null */
  side: SessionPaneSide | null;
}

export interface SessionDragRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** 计算光标落在主区容器的左半还是右半；不在主区内返回 null */
export function resolveDropSideAtPoint(
  clientX: number,
  clientY: number,
  rect: SessionDragRect,
): SessionPaneSide | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return null;
  }
  return clientX < rect.left + rect.width / 2 ? 'left' : 'right';
}

let activeDrag: ActiveSessionDrag | null = null;
let stopCurrentDrag: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of [...listeners]) fn();
}

function setActiveDrag(next: ActiveSessionDrag | null): void {
  activeDrag = next;
  emit();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** 订阅当前拖拽状态（仅在拖拽激活期间有值） */
export function useSessionPaneDrag(): ActiveSessionDrag | null {
  return useSyncExternalStore(
    subscribe,
    () => activeDrag,
    () => null,
  );
}

/** 仅订阅指定会话行是否正被拖动，避免拖拽过程牵动其它侧栏行重渲染 */
export function useIsSessionDragging(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => activeDrag?.id === id,
    () => false,
  );
}

/** 强制取消当前进行中的拖拽（测试清理或异常复位） */
export function cancelSessionPaneDrag(): void {
  stopCurrentDrag?.();
}

/** 当前是否处于拖拽激活状态（用于屏蔽侧栏悬停预览卡重绘） */
export function isSessionPaneDragging(): boolean {
  return activeDrag !== null;
}

function hitTestSessionPanes(
  clientX: number,
  clientY: number,
  canDrop: (side: SessionPaneSide) => boolean,
): SessionPaneSide | null {
  if (typeof document === 'undefined') return null;
  const host = document.querySelector<HTMLElement>('[data-testid="session-panes"]');
  if (!host || host.hidden || host.closest('[hidden], .chat-keepalive-hidden')) return null;
  const side = resolveDropSideAtPoint(clientX, clientY, host.getBoundingClientRect());
  if (!side) return null;
  return canDrop(side) ? side : null;
}

export function startSessionPaneDrag(
  e: {
    button: number;
    clientX: number;
    clientY: number;
    pointerId?: number;
    target: EventTarget | null;
  },
  opts: {
    id: string;
    sessionKey: string;
    title: string;
    canDrop: (side: SessionPaneSide) => boolean;
    onActivate?: () => void;
    onDrop: (side: SessionPaneSide) => void;
  },
): void {
  if (typeof window === 'undefined' || e.button !== 0) return;
  const targetEl = e.target as HTMLElement | null;
  if (targetEl?.closest('[data-testid="row-actions"], input, textarea')) return;

  stopCurrentDrag?.();

  const startX = e.clientX;
  const startY = e.clientY;
  const pointerId = e.pointerId;
  let dragging = false;
  let cancelled = false;
  let currentSide: SessionPaneSide | null = null;
  let prevUserSelect: string | null = null;

  const isSamePointer = (ev: PointerEvent) =>
    pointerId === undefined || ev.pointerId === undefined || ev.pointerId === pointerId;

  const restoreUserSelect = () => {
    if (prevUserSelect !== null && typeof document !== 'undefined') {
      document.body.style.userSelect = prevUserSelect;
      prevUserSelect = null;
    }
  };

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
    window.removeEventListener('dragstart', onDragStart, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', onBlur);
    restoreUserSelect();
    if (stopCurrentDrag === cancel) stopCurrentDrag = null;
    if (activeDrag) setActiveDrag(null);
  };

  const suppressNextClick = () => {
    const disarm = () => {
      window.removeEventListener('click', block, true);
      window.removeEventListener('pointerdown', disarm, true);
    };
    const block = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      disarm();
    };
    window.addEventListener('click', block, { capture: true, once: true });
    window.addEventListener('pointerdown', disarm, { capture: true, once: true });
    window.setTimeout(disarm, 0);
  };

  const onMove = (ev: PointerEvent) => {
    if (cancelled || !isSamePointer(ev)) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragging) {
      if (Math.hypot(dx, dy) < SESSION_DRAG_THRESHOLD_PX) return;
      dragging = true;
      if (typeof document !== 'undefined') {
        prevUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = 'none';
      }
      opts.onActivate?.();
    }
    currentSide = hitTestSessionPanes(ev.clientX, ev.clientY, opts.canDrop);
    setActiveDrag({
      id: opts.id,
      sessionKey: opts.sessionKey,
      title: opts.title,
      x: ev.clientX,
      y: ev.clientY,
      side: currentSide,
    });
  };

  const onUp = (ev: PointerEvent) => {
    if (!isSamePointer(ev)) return;
    const hasCoords = ev.clientX !== 0 || ev.clientY !== 0;
    const dropSide =
      dragging && !cancelled
        ? hasCoords
          ? hitTestSessionPanes(ev.clientX, ev.clientY, opts.canDrop)
          : currentSide
        : null;
    const shouldSuppressClick = dragging || cancelled;
    cleanup();
    if (shouldSuppressClick) suppressNextClick();
    if (dropSide) opts.onDrop(dropSide);
  };

  const cancelWithSuppress = () => {
    const shouldSuppressClick = dragging;
    cleanup();
    if (shouldSuppressClick) suppressNextClick();
  };

  const onPointerCancel = (ev: PointerEvent) => {
    if (!isSamePointer(ev)) return;
    cancelWithSuppress();
  };

  const onBlur = () => {
    cancelWithSuppress();
  };

  const onDragStart = (ev: DragEvent) => {
    ev.preventDefault();
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    cancelled = true;
    currentSide = null;
    restoreUserSelect();
    if (activeDrag) setActiveDrag(null);
  };

  const cancel = () => {
    cleanup();
  };
  stopCurrentDrag = cancel;

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onPointerCancel, true);
  window.addEventListener('dragstart', onDragStart, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onBlur);
}
