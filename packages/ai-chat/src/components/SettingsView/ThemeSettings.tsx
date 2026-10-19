/** 设置 → 通用 → 主题：四套配色 + 跟随系统，点选即时生效（对话窗口与看板娘同步）。 */
import { t as tr } from '@nomi-ai/ui';
import { THEMES, currentTheme, setTheme, type ThemeState } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import styles from './index.module.css';

export const ThemeSettings: React.FC = () => {
  const [cur, setCur] = useState<ThemeState>(currentTheme);
  useEffect(() => {
    const on = (e: Event) => setCur((e as CustomEvent<ThemeState>).detail);
    window.addEventListener('cd:theme-changed', on);
    return () => window.removeEventListener('cd:theme-changed', on);
  }, []);
  return (
    <section className={styles.block} data-testid="theme-settings">
      <h2 className={styles.h2}>{tr('主题')}</h2>
      <div className={styles.themes} role="radiogroup" aria-label={tr('主题')}>
        {THEMES.map((t) => {
          const on = cur.pref === t.id;
          const sys = t.id === 'system';
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`${styles.theme} ${on ? styles.themeOn : ''}`}
              onClick={() => void setTheme(t.id)}
              data-testid={`theme-${t.id}`}
            >
              <span
                className={styles.themePreview}
                style={{
                  background: sys
                    ? `linear-gradient(110deg, ${t.swatch[0]} 50%, ${t.swatch[2]} 50%)`
                    : t.swatch[0],
                  borderColor: t.swatch[1],
                }}
                aria-hidden
              >
                {!sys && (
                  <span style={{ background: t.swatch[1] }} className={styles.themeCard}>
                    <span style={{ background: t.swatch[2] }} className={styles.themeLine} />
                    <span
                      style={{ background: t.swatch[2], opacity: 0.45 }}
                      className={styles.themeLine}
                    />
                    <span style={{ background: t.swatch[3] }} className={styles.themeDot} />
                  </span>
                )}
              </span>
              <span className={styles.themeName}>{tr(t.name)}</span>
              <span className={styles.themeDesc}>
                {sys && on
                  ? tr(
                      '{0}（当前：{1}）',
                      tr(t.desc),
                      cur.resolved === 'cream' ? tr('奶油') : tr('石墨'),
                    )
                  : tr(t.desc)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};
