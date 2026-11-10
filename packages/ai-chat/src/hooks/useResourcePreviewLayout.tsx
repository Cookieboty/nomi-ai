import { t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { startSplitDrag } from '../utils/splitDrag';

import styles from './ResourcePreviewHost.module.css';

/** Layout-only state: expanding never replaces the mounted conversation or composer. */
export function useResourcePreviewLayout(isOpen: boolean) {
  const [width, setWidth] = useState(0.5);
  const [dragging, setDragging] = useState(false);
  const sideWidth = useRef(0.5);
  const stopDrag = useRef<(() => void) | undefined>(undefined);
  const expanded = width === 1;
  useEffect(() => {
    if (!isOpen) stopDrag.current?.();
    return () => stopDrag.current?.();
  }, [isOpen]);
  const reset = useCallback(() => {
    stopDrag.current?.();
    setWidth(0.5);
    sideWidth.current = 0.5;
  }, []);
  const resize = (next: number) => {
    const value = next >= 0.96 ? 1 : Math.max(0.25, Math.min(0.94, next));
    if (value < 1) sideWidth.current = value;
    setWidth(value);
  };
  const onExpanded = (next: boolean) => setWidth(next ? 1 : sideWidth.current);
  return {
    expanded,
    reset,
    onExpanded,
    style: { '--resource-preview-width': `${width * 100}%` } as React.CSSProperties,
    splitter: isOpen ? (
      <div
        className={`${styles.splitter} ${dragging ? styles.dragging : ''}`}
        role="separator"
        aria-label={t('ui.session-workspace.preview-resize')}
        aria-orientation="vertical"
        aria-valuemin={25}
        aria-valuemax={100}
        aria-valuenow={Math.round(width * 100)}
        tabIndex={0}
        data-testid="resource-preview-splitter"
        data-expanded={expanded || undefined}
        onKeyDown={(event) => {
          let next: number;
          switch (event.key) {
            case 'ArrowLeft':
              next = width + 0.05;
              break;
            case 'ArrowRight':
              next = width - 0.05;
              break;
            case 'Home':
              next = 0.5;
              break;
            case 'End':
              next = 1;
              break;
            default:
              return;
          }
          event.preventDefault();
          resize(next);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
          if (!bounds?.width) return;
          event.preventDefault();
          stopDrag.current?.();
          const initialWidth = width;
          const initialSide = sideWidth.current;
          setDragging(true);
          stopDrag.current = startSplitDrag({
            el: event.currentTarget,
            pointerId: event.pointerId,
            onMove: (ev) => {
              const remaining = ev.clientX - bounds.left;
              resize(remaining <= 48 ? 1 : (bounds.right - ev.clientX) / bounds.width);
            },
            onEnd: (cancelled) => {
              stopDrag.current = undefined;
              setDragging(false);
              if (cancelled) {
                setWidth(initialWidth);
                sideWidth.current = initialSide;
              }
            },
          });
        }}
      />
    ) : null,
  };
}
