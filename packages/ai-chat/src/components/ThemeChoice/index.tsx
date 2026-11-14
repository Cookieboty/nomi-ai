/** 引导与设置共用的主题卡片：微缩工作台、指针微光和选中反馈。 */
import { IconCheck } from '@tabler/icons-react';
import React, { type CSSProperties } from 'react';

import styles from './index.module.css';

export type ThemeSwatch = readonly [string, string, string, string];

export const ThemeMiniature: React.FC<{
  swatch: ThemeSwatch;
  system?: boolean;
  split?: string | null;
  style?: CSSProperties;
  testId?: string;
  layers?: React.ReactNode;
  placeholder?: React.ReactNode;
  translucent?: boolean;
}> = ({ swatch, system, split, style, testId, layers, placeholder, translucent }) => {
  const [bg, surface, text, accent] = swatch;
  return (
    <span
      className={`${styles.preview} ${system ? styles.system : ''}`}
      style={{
        backgroundColor: bg,
        ...(split ? { backgroundImage: `linear-gradient(110deg, ${bg} 50%, ${split} 50%)` } : {}),
        ...style,
      }}
      data-testid={testId}
      aria-hidden="true"
    >
      {layers && <span className={styles.imageLayers}>{layers}</span>}
      {placeholder ? (
        <span className={styles.placeholder}>{placeholder}</span>
      ) : system ? (
        <>
          <span className={styles.splitLight}>
            <span className={styles.bubbleAi} style={{ background: '#18181b', opacity: 0.55 }} />
          </span>
          <span className={styles.splitDark}>
            <span className={styles.bubbleUser} style={{ background: accent }} />
            <span className={styles.bubbleAi} style={{ background: '#f4f4f5', opacity: 0.65 }} />
          </span>
        </>
      ) : (
        <>
          <span className={styles.sidebar}>
            <span className={styles.navDot} style={{ background: text, opacity: 0.28 }} />
            <span className={styles.navDot} style={{ background: text, opacity: 0.16 }} />
          </span>
          <span
            className={styles.pane}
            style={{
              background: translucent ? `color-mix(in srgb, ${surface} 55%, transparent)` : surface,
            }}
          >
            <span className={styles.bubbleUser} style={{ background: accent }} />
            <span className={styles.bubbleAi} style={{ background: text, opacity: 0.52 }} />
          </span>
        </>
      )}
    </span>
  );
};

export const ThemeChoice: React.FC<{
  label: string;
  selected: boolean;
  preview: React.ReactNode;
  labelIcon?: React.ReactNode;
  description?: string;
  testId: string;
  className?: string;
  style?: CSSProperties;
  onPick: () => void;
}> = ({
  label,
  selected,
  preview,
  labelIcon,
  description,
  testId,
  className = '',
  style,
  onPick,
}) => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    aria-description={description}
    className={`${styles.choice} ${selected ? styles.selected : ''} ${className}`}
    style={style}
    data-testid={testId}
    onPointerMove={(e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      e.currentTarget.style.setProperty('--mx', `${e.clientX - rect.left}px`);
      e.currentTarget.style.setProperty('--my', `${e.clientY - rect.top}px`);
    }}
    onClick={onPick}
  >
    {preview}
    <span className={styles.label}>
      {labelIcon}
      <span className={styles.labelText} title={label}>
        {label}
      </span>
    </span>
    <span className={styles.check} aria-hidden="true">
      <IconCheck size={13} strokeWidth={2.75} />
    </span>
  </button>
);
