import { brand } from '@nomi-ai/types';
import { ENDPOINT_GLYPHS } from '@nomi-ai/ui';
import React, { forwardRef, useId } from 'react';

import styles from './index.module.css';
import { WORDMARK_LETTERS } from './wordmark';

/** 开屏与标题栏共用同一套矢量，落位时字形、间距和图形均不切换。 */
export const BrandLockup = forwardRef<
  HTMLSpanElement,
  {
    animated?: boolean;
    skipped?: boolean;
  }
>(function BrandLockup({ animated, skipped }, ref) {
  const id = useId().replace(/:/g, '');
  const glyph = ENDPOINT_GLYPHS.nomi;
  // 开屏按实际大尺寸绘制，避免把标题栏的小 SVG 合成纹理放大。
  const scale = animated ? 4.5 : 1;
  return (
    <span
      ref={ref}
      className={styles.lockup}
      data-animated={animated || undefined}
      data-skipped={skipped || undefined}
      aria-label={brand.appName}
      style={{ '--brand-scale': scale } as React.CSSProperties}
    >
      <svg
        width={20 * scale}
        height={20 * scale}
        viewBox="0 0 16 16"
        aria-hidden
        data-testid="endpoint-icon-nomi"
        data-endpoint="nomi"
        className={styles.mark}
      >
        <rect width="16" height="16" rx="4" fill={glyph.tile} />
        {glyph.paths.map((p, i) => (
          <path
            key={i}
            d={p.d}
            transform={p.transform}
            fill={p.fill ?? 'none'}
            stroke={p.stroke}
            strokeWidth={p.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength="1"
            className={i === 2 ? styles.star : styles.ink}
            style={
              {
                '--ink-delay': i === 0 ? '275ms' : '70ms',
                '--ink-duration': i === 0 ? '540ms' : '735ms',
              } as React.CSSProperties
            }
          />
        ))}
      </svg>
      <svg
        width={34 * scale}
        height={20 * scale}
        viewBox="276 38 310 182"
        aria-hidden
        className={styles.word}
      >
        {animated && (
          <defs>
            {WORDMARK_LETTERS.map((letter, i) => (
              <mask
                key={i}
                id={`${id}-letter-${i}`}
                maskUnits="userSpaceOnUse"
                x="276"
                y="38"
                width="310"
                height="182"
              >
                {letter.strokes.map((d, j) => (
                  <path
                    key={j}
                    d={d}
                    fill="none"
                    stroke="white"
                    strokeWidth="25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    pathLength="1"
                    className={styles.ink}
                    style={
                      {
                        '--ink-delay': `${500 + i * 190 + j * 70}ms`,
                        '--ink-duration': i === 2 ? '230ms' : '195ms',
                      } as React.CSSProperties
                    }
                  />
                ))}
              </mask>
            ))}
          </defs>
        )}
        {WORDMARK_LETTERS.map((letter, i) => (
          <path
            key={i}
            d={letter.d}
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinejoin="round"
            paintOrder="stroke fill"
            mask={animated ? `url(#${id}-letter-${i})` : undefined}
          />
        ))}
      </svg>
    </span>
  );
});
