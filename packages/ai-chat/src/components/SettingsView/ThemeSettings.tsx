/** 设置 → 通用 → 外观 → 主题：配色与图片主题，点选即时生效。 */
import { Icon, SettingRow, t as tr } from '@nomi-ai/ui';
import { THEMES, currentTheme, setTheme, type ThemeState } from '@nomi-ai/ui';
import { Check, Image } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import {
  getChatBackground,
  subscribeChatBackground,
  type ChatBackgroundState,
} from '../../services/chatBackground';

import { ChatBackgroundSettings } from './ChatBackgroundSettings';
import styles from './index.module.css';

/** 跟随系统放最前，其余按 THEMES 顺序 */
const ORDERED = [
  ...THEMES.filter((x) => x.id === 'system'),
  ...THEMES.filter((x) => x.id !== 'system'),
];

/** 当前主题的显示名（品牌卡速览也用） */
export function themeLabel(cur: ThemeState): string {
  const def = THEMES.find((x) => x.id === cur.pref);
  if (cur.pref === 'system')
    return tr(
      'ui.chat-settings.system',
      cur.resolved === 'cream'
        ? tr('ui.mascot-theme.cream-short')
        : tr('ui.chat-settings.graphite'),
    );
  return def ? tr(def.name) : cur.pref;
}

export function useThemeState(): ThemeState {
  const [cur, setCur] = useState<ThemeState>(currentTheme);
  useEffect(() => {
    const on = (e: Event) => setCur((e as CustomEvent<ThemeState>).detail);
    window.addEventListener('cd:theme-changed', on);
    return () => window.removeEventListener('cd:theme-changed', on);
  }, []);
  return cur;
}

export const ThemeSettings: React.FC = () => {
  const cur = useThemeState();
  const [background, setBackground] = useState<ChatBackgroundState>(getChatBackground);
  useEffect(() => subscribeChatBackground(setBackground), []);
  const sel = THEMES.find((x) => x.id === cur.pref);
  return (
    <div className={styles.themeBlock} data-testid="theme-settings" id="settings-theme">
      <SettingRow
        title={tr('ui.chat-settings.theme')}
        description={
          sel
            ? sel.id === 'system'
              ? tr(
                  'ui.chat-settings.current',
                  tr(sel.desc),
                  cur.resolved === 'cream'
                    ? tr('ui.mascot-theme.cream-short')
                    : tr('ui.chat-settings.graphite'),
                )
              : tr(sel.desc)
            : undefined
        }
      />
      <div className={styles.themes} role="radiogroup" aria-label={tr('ui.chat-settings.theme')}>
        {ORDERED.map((t) => {
          const on = cur.pref === t.id;
          const sys = t.id === 'system';
          const image = t.id === 'image';
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={on}
              title={tr(t.desc)}
              className={`${styles.theme} ${on ? styles.themeOn : ''}`}
              onClick={() => void setTheme(t.id)}
              data-testid={`theme-${t.id}`}
            >
              <span
                className={styles.themePreview}
                style={{
                  backgroundColor: t.swatch[0],
                  borderColor: t.swatch[1],
                  backgroundImage: sys
                    ? `linear-gradient(110deg, ${t.swatch[0]} 50%, ${t.swatch[2]} 50%)`
                    : image && background.imageUrl
                      ? `url("${background.imageUrl.replace(/"/g, '\\"')}")`
                      : 'none',
                }}
                aria-hidden
              >
                {image && !background.imageUrl ? (
                  <span className={styles.themeImagePlaceholder}>
                    <Icon icon={Image} size={24} />
                  </span>
                ) : !sys ? (
                  <span
                    style={{
                      background: image
                        ? `color-mix(in srgb, ${t.swatch[1]} 55%, transparent)`
                        : t.swatch[1],
                    }}
                    className={styles.themeCard}
                  >
                    <span style={{ background: t.swatch[2] }} className={styles.themeLine} />
                    <span
                      style={{ background: t.swatch[2], opacity: 0.45 }}
                      className={styles.themeLine}
                    />
                    <span style={{ background: t.swatch[3] }} className={styles.themeDot} />
                  </span>
                ) : null}
                {on && (
                  <span className={styles.themeCheck}>
                    <Icon icon={Check} size={12} />
                  </span>
                )}
              </span>
              <span className={styles.themeName}>{tr(t.name)}</span>
            </button>
          );
        })}
      </div>
      {cur.pref === 'image' && <ChatBackgroundSettings />}
    </div>
  );
};
