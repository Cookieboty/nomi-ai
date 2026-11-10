import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import type { ResourceScope } from '../../contexts/ResourceContext';
import { startSplitDrag } from '../../utils/splitDrag';

import { PREVIEW_CHAT_DISMISS } from './dismiss';

import { PreviewChat } from './index';

/** Positions the existing chat column; it never creates a second conversation/composer. */
export function usePreviewChatWindow(
  active: boolean,
  onSelected: (scope: ResourceScope) => void,
  workspaceCwd: string | null | undefined,
) {
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const stop = useRef<(() => void) | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const ownedPointers = useRef(new WeakSet<Event>());
  useEffect(() => {
    if (!active || !ref.current) return;
    const column = ref.current;
    const dismiss = (event: Event) => {
      if (event.defaultPrevented || !expanded) return;
      event.preventDefault();
      setExpanded(false);
      column.querySelector<HTMLButtonElement>('[data-testid="preview-chat-toggle"]')?.focus();
    };
    const outside = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        ownedPointers.current.has(event) ||
        column.contains(event.target as Node) ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      )
        return;
      setExpanded(false);
    };
    column.addEventListener(PREVIEW_CHAT_DISMISS, dismiss);
    window.addEventListener('pointerdown', outside);
    return () => {
      column.removeEventListener(PREVIEW_CHAT_DISMISS, dismiss);
      window.removeEventListener('pointerdown', outside);
    };
  }, [active, expanded]);
  useEffect(() => {
    if (!active) stop.current?.();
    return () => stop.current?.();
  }, [active]);
  useLayoutEffect(() => {
    if (!active || !ref.current || !ref.current.parentElement) return;
    const column = ref.current;
    const host = column.parentElement!;
    const keepVisible = () => {
      const box = column.getBoundingClientRect();
      const bounds = host.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const dx = Math.max(bounds.left + 8 - box.left, Math.min(bounds.right - 8 - box.right, 0));
      const dy = Math.max(bounds.top + 8 - box.top, Math.min(bounds.bottom - 8 - box.bottom, 0));
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)
        setOffset((old) => ({ x: old.x + dx, y: old.y + dy }));
    };
    keepVisible();
    const observer = new ResizeObserver(keepVisible);
    observer.observe(host);
    observer.observe(column);
    return () => observer.disconnect();
  }, [active, expanded]);
  const onMoveKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const delta = {
      ArrowLeft: [-16, 0],
      ArrowRight: [16, 0],
      ArrowUp: [0, -16],
      ArrowDown: [0, 16],
    }[event.key];
    if (!delta || !ref.current?.parentElement) return;
    event.preventDefault();
    event.stopPropagation();
    const box = ref.current.getBoundingClientRect();
    const bounds = ref.current.parentElement.getBoundingClientRect();
    setOffset((old) => ({
      x:
        old.x +
        Math.max(bounds.left + 8 - box.left, Math.min(bounds.right - 8 - box.right, delta[0])),
      y:
        old.y +
        Math.max(bounds.top + 8 - box.top, Math.min(bounds.bottom - 8 - box.bottom, delta[1])),
    }));
  };
  const toggle = () => setExpanded((old) => !old);
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      const column = event.currentTarget.closest<HTMLElement>('[data-testid="chat-column"]');
      const host = column?.parentElement;
      if (!column || !host) return;
      event.preventDefault();
      stop.current?.();
      const box = column.getBoundingClientRect();
      const bounds = host.getBoundingClientRect();
      const origin = offset;
      stop.current = startSplitDrag({
        el: event.currentTarget,
        pointerId: event.pointerId,
        onMove: (move) =>
          setOffset({
            x:
              origin.x +
              Math.max(
                bounds.left + 8 - box.left,
                Math.min(bounds.right - 8 - box.right, move.clientX - event.clientX),
              ),
            y:
              origin.y +
              Math.max(
                bounds.top + 8 - box.top,
                Math.min(bounds.bottom - 8 - box.bottom, move.clientY - event.clientY),
              ),
          }),
        onEnd: (cancelled) => {
          stop.current = undefined;
          if (cancelled) setOffset(origin);
        },
      });
    },
    [offset],
  );
  return {
    ref,
    expanded: active && expanded,
    busy,
    events: {
      // React capture follows owned portals too (session/model/permission menus).
      onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => {
        ownedPointers.current.add(event.nativeEvent);
      },
    },
    style: active
      ? ({
          '--preview-chat-x': `${offset.x}px`,
          '--preview-chat-y': `${offset.y}px`,
        } as CSSProperties)
      : undefined,
    header: active ? (
      <PreviewChat
        expanded={expanded}
        onToggle={toggle}
        onDrag={onPointerDown}
        onMoveKey={onMoveKey}
        onExpand={() => setExpanded(true)}
        workspaceCwd={workspaceCwd}
        onSelected={onSelected}
        onBusy={setBusy}
      />
    ) : null,
  };
}
