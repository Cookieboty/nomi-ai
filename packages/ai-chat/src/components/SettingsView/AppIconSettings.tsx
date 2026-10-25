/**
 * 设置 → 通用 → 外观：应用图标（sunset 默认 / cream / ink），一行设置，右侧三个小图标单选。
 * 主进程 core/appIcon.ts（app-icon:*）。
 */
import { SettingRow, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import styles from './index.module.css';

type Variant = 'ink' | 'cream' | 'sunset';
interface IconState {
  variant: Variant;
  platform: string;
  previews: Record<Variant, string>;
}
type Invoke = (ch: string, ...a: unknown[]) => Promise<unknown>;
type NamedApi = Record<string, (...a: unknown[]) => Promise<unknown>>;
/** preload 只暴露命名白名单（electronAPI.appIcon.*），这里把通道名映射到具名方法 */
const CHANNELS: Record<string, string> = { 'app-icon:get': 'get', 'app-icon:set': 'set' };
const invoke = (): Invoke | null => {
  const api = (window as unknown as { electronAPI?: { appIcon?: NamedApi } }).electronAPI?.appIcon;
  if (!api) return null;
  return (ch, ...a) => {
    const fn = api[CHANNELS[ch] ?? ''];
    return fn ? fn(...a) : Promise.reject(new Error(`unknown channel ${ch}`));
  };
};

const LABEL: Record<Variant, string> = {
  sunset: 'ui.mascot-theme.sunset-orange-default',
  cream: 'ui.mascot-theme.cream-bbfb59',
  ink: 'ui.mascot-theme.ink',
};

export const AppIconSettings: React.FC = () => {
  const [s, setS] = useState<IconState | null>(null);
  useEffect(() => {
    void invoke()?.('app-icon:get').then((v) => setS(v as IconState));
  }, []);
  if (!invoke() || !s) return null;
  const pick = (v: Variant) =>
    void invoke()?.('app-icon:set', v).then((r) => setS({ ...s, variant: r as Variant }));
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
