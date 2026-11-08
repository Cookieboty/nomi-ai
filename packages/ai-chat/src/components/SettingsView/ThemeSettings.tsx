/** 设置 → 通用 → 外观 → 主题：配色与图片主题，点选即时生效。 */
import { Icon, SettingRow, t as tr } from '@nomi-ai/ui';
import { THEMES, currentTheme, setTheme, type ThemePref, type ThemeState } from '@nomi-ai/ui';
import { Check, ChevronDown, ChevronUp, Image } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import {
  chatBgErrorMessage,
  chatBgStyle,
  getChatBackground,
  pickChatBackgroundImage,
  subscribeChatBackground,
  type ChatBackgroundState,
} from '../../services/chatBackground';

import { ChatBackgroundSettings } from './ChatBackgroundSettings';
import styles from './index.module.css';

/** 默认只显示一行（5 个），其余点「更多主题」展开 */
export const THEMES_FIRST_ROW = 5;

/**
 * 排序：跟随系统放最前，其余按 THEMES 顺序；当前选的不在第一行（前 THEMES_FIRST_ROW 个）时挪到第二个，
 * 这样收起时也看得到选中的是哪个。打开时定一次，点选时不重排（不让卡片在手下跳）
 */
export function orderThemes(pref: ThemePref) {
  const base = [
    ...THEMES.filter((x) => x.id === 'system'),
    ...THEMES.filter((x) => x.id !== 'system'),
  ];
  const i = base.findIndex((x) => x.id === pref);
  if (i < THEMES_FIRST_ROW) return base;
  const [picked] = base.splice(i, 1);
  base.splice(1, 0, picked!);
  return base;
}

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

/**
 * 图片主题还没有任何图片（预设缺失且未选图）时先弹选图，选到了才切主题，避免切到无图的空深色。
 * 选图失败返回给用户看的错误文案，否则返回 null。
 */
export async function selectTheme(
  id: ThemePref,
  background: ChatBackgroundState,
): Promise<string | null> {
  if (id === 'image' && !background.imageUrl) {
    let picked: ChatBackgroundState;
    try {
      picked = await pickChatBackgroundImage();
    } catch (error) {
      return chatBgErrorMessage(error);
    }
    if (!picked.imageUrl) return null;
  }
  await setTheme(id);
  return null;
}

export const ThemeSettings: React.FC = () => {
  const cur = useThemeState();
  const [background, setBackground] = useState<ChatBackgroundState>(getChatBackground);
  useEffect(() => subscribeChatBackground(setBackground), []);
  const [pickError, setPickError] = useState<string | null>(null);
  const sel = THEMES.find((x) => x.id === cur.pref);
  const [ordered] = useState(() => orderThemes(cur.pref));
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(0, ordered.length - THEMES_FIRST_ROW);
  const shown = expanded ? ordered : ordered.slice(0, THEMES_FIRST_ROW);
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
      <div
        className={styles.themes}
        role="radiogroup"
        aria-label={tr('ui.chat-settings.theme')}
        id="settings-theme-options"
      >
        {shown.map((t) => {
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
              onClick={() => void selectTheme(t.id, background).then(setPickError)}
              data-testid={`theme-${t.id}`}
            >
              <span
                className={styles.themePreview}
                style={{
                  ...(image ? chatBgStyle(background) : {}),
                  backgroundColor: t.swatch[0],
                  borderColor: t.swatch[1],
                  backgroundImage: sys
                    ? `linear-gradient(110deg, ${t.swatch[0]} 50%, ${t.swatch[2]} 50%)`
                    : 'none',
                }}
                aria-hidden
                data-testid={image ? 'theme-bg-preview' : undefined}
              >
                {image && background.imageUrl && (
                  <span className={styles.themeImageLayers}>
                    <span className="chat-bg-image" data-testid="theme-bg-image" />
                    <span className="chat-bg-mask" data-testid="theme-bg-mask" />
                  </span>
                )}
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
      {hiddenCount > 0 && (
        <button
          type="button"
          className={styles.themeMore}
          aria-expanded={expanded}
          aria-controls="settings-theme-options"
          onClick={() => setExpanded((v) => !v)}
          data-testid="theme-more"
        >
          {expanded
            ? tr('ui.knowledge-local.collapse')
            : tr('ui.chat-settings.more-themes', String(hiddenCount))}
          <Icon icon={expanded ? ChevronUp : ChevronDown} size={14} />
        </button>
      )}
      {pickError && cur.pref !== 'image' && (
        <div className={styles.warn} role="alert" data-testid="theme-image-error">
          {pickError}
        </div>
      )}
      {cur.pref === 'image' && <ChatBackgroundSettings />}
    </div>
  );
};
