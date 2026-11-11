import { t } from '@nomi-ai/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  clampSidebarWidth,
  persistSidebarWidth,
  readSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '../../utils/sidebarWidth';
import { startSplitDrag } from '../../utils/splitDrag';

import styles from './index.module.css';

/**
 * 会话面板宽度的拖动手柄。宽度写到根元素的 --sidebar-panel-w-user：App.css 在 .ai-chat-app 上按窗口宽度封顶
 * 成 --sidebar-panel-w，面板用它、四栏最小宽度也按它扣，窄窗口里侧栏拖宽了也不会把右边各栏挤出屏幕。
 */
export function useSidebarResize(enabled: boolean) {
  const [width, setWidth] = useState(readSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const stop = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--sidebar-panel-w-user', `${width}px`);
    return () => {
      root.removeProperty('--sidebar-panel-w-user');
    };
  }, [width]);
  useEffect(() => {
    if (!enabled) stop.current?.();
    return () => stop.current?.();
  }, [enabled]);

  const commit = (next: number) => {
    stop.current?.();
    const value = clampSidebarWidth(next);
    setWidth(value);
    persistSidebarWidth(value);
  };

  return {
    width,
    splitter: enabled ? (
      <div
        className={`${styles.resizeHandle} ${dragging ? styles.resizing : ''}`}
        data-testid="sidebar-resize-handle"
        role="separator"
        aria-label={t('ui.chat-settings.resize-sidebar')}
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onLostPointerCapture={() => stop.current?.()}
        onDoubleClick={() => commit(SIDEBAR_WIDTH_DEFAULT)}
        onKeyDown={(event) => {
          const widths: Record<string, number> = {
            ArrowLeft: width - 10,
            ArrowRight: width + 10,
            Home: SIDEBAR_WIDTH_MIN,
            End: SIDEBAR_WIDTH_MAX,
          };
          const next = widths[event.key];
          if (next === undefined) return;
          event.preventDefault();
          commit(next);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || stop.current) return;
          event.preventDefault();
          const initialWidth = width;
          const startX = event.clientX;
          const pointerId = event.pointerId;
          let currentWidth = width;
          const cursor = document.body.style.cursor;
          const userSelect = document.body.style.userSelect;
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
          setDragging(true);
          const cancel = () => stop.current?.();
          const onKey = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') {
              ev.preventDefault();
              cancel();
            }
          };
          window.addEventListener('blur', cancel);
          window.addEventListener('keydown', onKey);
          stop.current = startSplitDrag({
            el: event.currentTarget,
            pointerId,
            onMove: (ev) => {
              if (ev.pointerId !== pointerId) return;
              currentWidth = clampSidebarWidth(initialWidth + ev.clientX - startX);
              setWidth(currentWidth);
            },
            onEnd: (cancelled) => {
              stop.current = undefined;
              window.removeEventListener('blur', cancel);
              window.removeEventListener('keydown', onKey);
              document.body.style.cursor = cursor;
              document.body.style.userSelect = userSelect;
              setDragging(false);
              if (cancelled) setWidth(initialWidth);
              else persistSidebarWidth(currentWidth);
            },
          });
        }}
      />
    ) : null,
  };
}
