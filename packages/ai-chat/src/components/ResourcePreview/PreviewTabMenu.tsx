import { t } from '@nomi-ai/ui';
import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import styles from './PreviewTabMenu.module.css';
import { previewTabCloseKeys, type PreviewTabAction } from './previewTabs';
import type { PreviewEntry } from './ResourcePreview';

export interface PreviewTabMenuTarget {
  key: string;
  x: number;
  y: number;
  trigger: HTMLButtonElement;
}
const actions: { action: PreviewTabAction; label: string }[] = [
  { action: 'close', label: 'ui.session-workspace.preview-tab-close' },
  { action: 'all', label: 'ui.session-workspace.preview-tab-close-all' },
  { action: 'others', label: 'ui.session-workspace.preview-tab-close-others' },
  { action: 'left', label: 'ui.mascot-theme.close-tabs-to-the-left' },
  { action: 'right', label: 'ui.mascot-theme.close-tabs-to-the-right' },
];

/** Portaled outside the clipped tab strip/preview, using the app's themed menu surface. */
export function PreviewTabMenu({
  target,
  entries,
  onDismiss,
  onCloseEntries,
}: {
  target: PreviewTabMenuTarget;
  entries: PreviewEntry[];
  onDismiss: (restoreFocus?: boolean) => void;
  onCloseEntries: (keys: string[]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = root.current!;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(target.x, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(target.y, window.innerHeight - rect.height - 4))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) onDismiss();
    };
    const dismiss = () => onDismiss();
    const scroll = (event: Event) => {
      if (!menu.contains(event.target as Node)) onDismiss();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [target, onDismiss]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    // Never let Escape bubble to the preview's close-all handler.
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onDismiss(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      root.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  };
  return createPortal(
    <div
      ref={root}
      role="menu"
      aria-label={t('ui.session-workspace.preview-tab-actions')}
      className={styles.menu}
      style={{ left: target.x, top: target.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {actions.map(({ action, label }) => {
        const keys = previewTabCloseKeys(entries, target.key, action);
        return (
          <button
            key={action}
            type="button"
            role="menuitem"
            className={styles.item}
            disabled={!keys.length}
            data-testid={`preview-tab-${action}`}
            onClick={() => {
              onDismiss(true);
              onCloseEntries(keys);
            }}
          >
            {t(label)}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
