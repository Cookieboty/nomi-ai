/**
 * 自定义主题编辑器 · 背景图：选图（内核暂存）、移除、毛玻璃与蒙版不透明度（与图片主题同一套图层）。
 */
import { Button, DEFAULT_THEME_BG, Slider, t as tr, type ThemeBackground } from '@nomi-ai/ui';
import { ImagePlus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

import { hostAssetUrl } from '../../services/api';
import { pickThemeBackground, themeErrorText } from '../../services/customThemes';

import styles from './CustomThemeEditor.module.css';

export interface ThemeBackgroundFieldProps {
  value: ThemeBackground | null;
  onChange: (value: ThemeBackground | null) => void;
}

export const ThemeBackgroundField: React.FC<ThemeBackgroundFieldProps> = ({ value, onChange }) => {
  const [error, setError] = useState<string | null>(null);
  const pick = () =>
    void pickThemeBackground().then(
      (image) => {
        setError(null);
        if (image) onChange({ ...DEFAULT_THEME_BG, ...(value ?? {}), image });
      },
      (e: unknown) => setError(tr('ui.chat-settings.theme-image-failed', themeErrorText(e))),
    );
  return (
    <div className={styles.field} data-testid="custom-theme-background">
      <span className={styles.label}>{tr('ui.chat-settings.theme-background')}</span>
      <div className={styles.bgRow}>
        {value && (
          <span
            className={styles.bgThumb}
            style={{ backgroundImage: `url("${hostAssetUrl(value.image).replace(/"/g, '\\"')}")` }}
            aria-hidden
          />
        )}
        <Button size="sm" onClick={pick} data-testid="custom-theme-bg-pick">
          <ImagePlus size={14} strokeWidth={1.75} aria-hidden />
          {tr(value ? 'ui.chat-settings.theme-background-change' : 'ui.chat-settings.choose-image')}
        </Button>
        {value && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(null)}
            data-testid="custom-theme-bg-remove"
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden />
            {tr('ui.knowledge-local.remove-image')}
          </Button>
        )}
      </div>
      {value ? (
        <>
          <div className={styles.sliderRow}>
            <span className={styles.seedLabel}>{tr('ui.voice-mascot.frosted-glass')}</span>
            <Slider
              min={0}
              max={40}
              step={1}
              value={value.blur}
              aria-label={tr('ui.voice-mascot.frosted-glass')}
              data-testid="custom-theme-bg-blur"
              onChange={(e) => onChange({ ...value, blur: Number(e.target.value) })}
            />
            <span className={styles.sliderValue}>{value.blur}px</span>
          </div>
          <div className={styles.sliderRow}>
            <span className={styles.seedLabel}>{tr('ui.chat-settings.opacity')}</span>
            <Slider
              min={5}
              max={100}
              step={1}
              value={Math.round(value.opacity * 100)}
              aria-label={tr('ui.chat-settings.opacity')}
              data-testid="custom-theme-bg-opacity"
              onChange={(e) => onChange({ ...value, opacity: Number(e.target.value) / 100 })}
            />
            <span className={styles.sliderValue}>{Math.round(value.opacity * 100)}%</span>
          </div>
        </>
      ) : (
        <span className={styles.hint}>{tr('ui.chat-settings.theme-background-hint')}</span>
      )}
      {error && (
        <span className={styles.errorInline} role="alert">
          {error}
        </span>
      )}
    </div>
  );
};
