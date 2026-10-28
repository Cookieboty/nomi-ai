/**
 * 设置 → 通用 → 外观：应用图标（sunset 默认 / cream / ink），一行设置，右侧三个小图标单选。
 * 主进程 core/appIcon.ts（应用契约 `appIcon.*`）。
 */
import { SettingRow, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';

import styles from './index.module.css';

type Variant = 'ink' | 'cream' | 'sunset';
interface IconState {
  variant: Variant;
  platform: string;
  previews: Record<Variant, string>;
}
/** 主进程 core/appIcon（应用契约 `appIcon.*`，只在对话窗口）；没有契约传输时为 null */
const iconApi = () =>
  hasTransport()
    ? {
        get: () => api.appIcon.get() as Promise<IconState>,
        set: (variant: Variant) => api.appIcon.set({ variant }) as Promise<Variant>,
      }
    : null;

const LABEL: Record<Variant, string> = {
  sunset: 'ui.mascot-theme.sunset-orange-default',
  cream: 'ui.mascot-theme.cream-short',
  ink: 'ui.mascot-theme.ink',
};

export const AppIconSettings: React.FC = () => {
  const [s, setS] = useState<IconState | null>(null);
  useEffect(() => {
    void iconApi()
      ?.get()
      .then((v) => setS(v));
  }, []);
  if (!iconApi() || !s) return null;
  const pick = (v: Variant) =>
    void iconApi()
      ?.set(v)
      .then((r) => setS({ ...s, variant: r }));
  return (
    <SettingRow
      data-testid="settings-app-icon"
      title={t('ui.chat-settings.app-icon')}
      description={
        s.platform === 'darwin'
          ? t('ui.mascot-theme.updates-the-dock-icon-right-away-for-this')
          : t('ui.mascot-theme.updates-the-window-the-running-taskbar-button-and')
      }
    >
      <div role="radiogroup" aria-label={t('ui.chat-settings.app-icon')} className={styles.icons}>
        {(Object.keys(LABEL) as Variant[]).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={s.variant === v}
            aria-label={t(LABEL[v])}
            title={t(LABEL[v])}
            data-variant={v}
            className={`${styles.iconOpt} ${s.variant === v ? styles.iconOptOn : ''}`}
            onClick={() => pick(v)}
          >
            <img src={s.previews[v]} width={36} height={36} alt="" />
          </button>
        ))}
      </div>
    </SettingRow>
  );
};
