import { Icon, t } from '@nomi-ai/ui';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { startSplitDrag } from '../../utils/splitDrag';

import styles from './ResourcePreview.module.css';

export interface DocumentHeading {
  id: string;
  text: string;
  level: number;
}
/** A reversible outline rail. The resize handle always remains inside the pane. */
export function DocumentOutline({
  headings,
  active,
  open,
  onOpen,
  width = 256,
  onWidth,
  onPick,
}: {
  headings: DocumentHeading[];
  active: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  width?: number;
  onWidth?: (width: number) => void;
  onPick: (id: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);
  const stop = useRef<(() => void) | undefined>(undefined);
  const remembered = useRef(width);
  const [localWidth, setLocalWidth] = useState(width);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => stop.current?.(), []);
  useLayoutEffect(() => {
    const list = nav.current;
    const item = list?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!list || !item) return;
    const bounds = list.getBoundingClientRect();
    const target = item.getBoundingClientRect();
    // Scroll only this rail, and only when the active item is clipped. No focus stealing.
    if (target.top < bounds.top) list.scrollTop += target.top - bounds.top;
    else if (target.bottom > bounds.bottom) list.scrollTop += target.bottom - bounds.bottom;
  }, [active, open, headings]);
  const maxWidth = () =>
    Math.max(160, Math.min(480, (root.current?.parentElement?.clientWidth || 960) - 180));
  const resize = (next: number) => {
    if (next < 96) {
      onOpen(false);
      return;
    }
    const value = Math.max(160, Math.min(maxWidth(), next));
    remembered.current = value;
    setLocalWidth(value);
    onWidth?.(value);
    onOpen(true);
  };
  const toggle = () => {
    stop.current?.();
    if (!open) {
      const next = Math.min(maxWidth(), remembered.current);
      setLocalWidth(next);
      onWidth?.(next);
    }
    onOpen(!open);
  };
  return (
    <div
      ref={root}
      className={`${styles.outlinePane} ${dragging ? styles.outlineDragging : ''}`}
      data-testid="preview-outline-pane"
      data-collapsed={!open || undefined}
      style={open ? { width: localWidth } : undefined}
    >
      <div className={styles.outlineHead}>
        {open && <strong>{t('ui.session-workspace.preview-outline')}</strong>}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={t(
            open
              ? 'ui.session-workspace.preview-hide-outline'
              : 'ui.session-workspace.preview-show-outline',
          )}
          data-testid="preview-outline-toggle"
        >
          <Icon icon={open ? PanelLeftClose : PanelLeftOpen} size={16} />
        </button>
      </div>
      {open && (
        <nav
          ref={nav}
          className={styles.outline}
          aria-label={t('ui.session-workspace.preview-outline')}
          data-testid="preview-outline"
        >
          {!headings.length && <p>{t('ui.session-workspace.preview-no-headings')}</p>}
          {headings.map((heading) => (
            <button
              key={heading.id}
              type="button"
              title={heading.text}
              data-active={active === heading.id || undefined}
              aria-current={active === heading.id ? 'location' : undefined}
              style={{
                paddingInlineStart: `calc(var(--cd-space-3) + ${heading.level - 1} * var(--cd-space-3))`,
              }}
              onClick={() => onPick(heading.id)}
            >
              <span>{heading.text}</span>
            </button>
          ))}
        </nav>
      )}
      <div
        role="separator"
        aria-label={t('ui.session-workspace.preview-outline-resize')}
        aria-orientation="vertical"
        aria-valuemin={40}
        aria-valuemax={480}
        aria-valuenow={open ? Math.round(localWidth) : 40}
        tabIndex={0}
        className={styles.outlineSplitter}
        data-testid="preview-outline-splitter"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          if (event.key === 'Home') {
            onOpen(false);
            return;
          }
          if (event.key === 'End') {
            resize(maxWidth());
            return;
          }
          resize((open ? localWidth : 120) + (event.key === 'ArrowRight' ? 32 : -32));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const bounds = root.current?.getBoundingClientRect();
          if (!bounds) return;
          event.preventDefault();
          stop.current?.();
          const before = localWidth,
            wasOpen = open,
            oldRemembered = remembered.current;
          setDragging(true);
          stop.current = startSplitDrag({
            el: event.currentTarget,
            pointerId: event.pointerId,
            onMove: (ev) => resize(ev.clientX - bounds.left),
            onEnd: (cancelled) => {
              stop.current = undefined;
              setDragging(false);
              if (cancelled) {
                remembered.current = oldRemembered;
                setLocalWidth(before);
                onWidth?.(before);
                onOpen(wasOpen);
              }
            },
          });
        }}
      />
    </div>
  );
}
