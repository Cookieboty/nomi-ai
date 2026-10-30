/** 设置 → 通用 → 语言：跟随系统 / 中文 / English，切换即时生效（对话窗口、桌面角色、托盘、通知同步）。 */
import {
  getLocalePref,
  SegmentedControl,
  SettingRow,
  setLocalePref,
  t,
  useLocale,
  type LocalePref,
} from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

// 语言名始终用其本身的文字显示
// i18n-ignore
const ZH = '中文';

const OPTIONS: { id: LocalePref; label: () => string }[] = [
  { id: 'system', label: () => t('ui.mascot-theme.follow-system') },
  { id: 'zh-CN', label: () => ZH },
  { id: 'en', label: () => 'English' },
];

/** 一行设置（放在「启动与窗口」分组里） */
export const LanguageSettings: React.FC = () => {
  const locale = useLocale();
  const [pref, setPref] = useState<LocalePref>(getLocalePref);
  useEffect(() => {
    const on = (e: Event) => setPref((e as CustomEvent<{ pref: LocalePref }>).detail.pref);
    window.addEventListener('cd:locale-changed', on);
    return () => window.removeEventListener('cd:locale-changed', on);
  }, []);
  const current = locale === 'zh-CN' ? ZH : 'English';
  return (
    <SettingRow
      data-testid="language-settings"
      title={locale === 'zh-CN' ? t('ui.voice-mascot.language') + ' · Language' : 'Language'}
      description={
        pref === 'system'
          ? t('ui.chat-settings.following-the-system-currently-chat-nomi-tray-and', current)
          : t('ui.chat-settings.chat-nomi-tray-and-notifications-switch-instantly')
      }
    >
      <SegmentedControl
        aria-label={t('ui.voice-mascot.language')}
        value={pref}
        onChange={(v) => void setLocalePref(v)}
        options={OPTIONS.map((o) => ({ value: o.id, label: o.label(), testId: `locale-${o.id}` }))}
      />
    </SettingRow>
  );
};
