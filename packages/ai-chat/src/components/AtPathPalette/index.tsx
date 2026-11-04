/**
 * Workspace path picker for composer `@` mentions.
 * Keyboard (↑↓ Enter Tab Esc) is handled by MessageInput; this only renders and mouse-selects.
 */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useRef } from 'react';

import type { AtPathOption } from '../../slash/atPathComplete';

import styles from './index.module.css';
import {
  AT_PATH_EMPTY_KEY,
  AT_PATH_KIND_DIR_KEY,
  AT_PATH_KIND_FILE_KEY,
  AT_PATH_MENU_KEY,
} from './keys';

export interface AtPathPaletteProps {
  options: readonly AtPathOption[];
  active: number;
  onPick: (o: AtPathOption) => void;
  onHover: (i: number) => void;
}

function visiblePath(option: AtPathOption): string {
  const p = option.path.replace(/\\/g, '/');
  if (option.kind === 'dir' && !p.endsWith('/')) return `${p}/`;
  return p;
}

export const AtPathPalette: React.FC<AtPathPaletteProps> = ({
  options,
  active,
  onPick,
  onHover,
}) => {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, options]);

  if (!options.length) {
    return (
      <div
        className={styles.menu}
        role="menu"
        data-testid="at-path-menu"
        aria-label={t(AT_PATH_MENU_KEY)}
      >
        <div className={styles.empty} data-testid="at-path-empty">
          {t(AT_PATH_EMPTY_KEY)}
        </div>
      </div>
    );
  }

  return (
    <div
      className={styles.menu}
      role="menu"
      data-testid="at-path-menu"
      aria-label={t(AT_PATH_MENU_KEY)}
    >
      {options.map((o, i) => {
        const on = i === active;
        return (
          <button
            key={`${o.kind}:${o.path}`}
            ref={on ? activeRef : undefined}
            type="button"
            role="menuitem"
            className={`${styles.item} ${on ? styles.on : ''}`}
            data-testid="at-path-item"
            data-kind={o.kind}
            aria-current={on ? 'true' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => !on && onHover(i)}
            onClick={() => onPick(o)}
          >
            <span className={styles.name}>{visiblePath(o)}</span>
            <span className={styles.kind}>
              {o.kind === 'dir' ? t(AT_PATH_KIND_DIR_KEY) : t(AT_PATH_KIND_FILE_KEY)}
            </span>
          </button>
        );
      })}
    </div>
  );
};
