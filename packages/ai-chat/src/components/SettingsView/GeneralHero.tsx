/**
 * 「通用」页横幅下方的速览卡：版本 / 主题 / 语言三格，点一格滚到对应设置。
 */
import { getLocalePref, Icon, t, useLocale, type LocalePref } from '@nomi-ai/ui';
import { Globe, Palette, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import styles from './GeneralHero.module.css';
import { themeLabel, useThemeState } from './ThemeSettings';
import { useUpdateState, type UpdateState } from './UpdateSettings';

type Tone = 'ok' | 'warn' | undefined;

function versionFacts(s: UpdateState | null): { value: string; sub: string; tone: Tone } {
  if (!s)
    return {
      value: '—',
      sub: t('ui.chat-settings.version-info-is-only-available-in-the-desktop'),
      tone: undefined,
    };
  const v = s.currentVersion;
  switch (s.status) {
    case 'not-available':
      return {
        value: v,
        sub: s.releasePending
          ? t('ui.mascot-theme.new-version-still-publishing')
          : t('ui.mascot-theme.you-are-up-to-date'),
        tone: 'ok',
      };
    case 'available':
      return {
        value: v,
        sub: t('ui.mascot-theme.update-is-available', s.availableVersion ?? ''),
        tone: 'warn',
      };
    case 'downloading':
      return {
        value: v,
        sub: t('ui.mascot-theme.downloading-update', Math.round(s.percent ?? 0)),
        tone: 'warn',
      };
    case 'downloaded':
      return {
        value: v,
        sub: t('ui.mascot-theme.update-downloaded-restart-to-install'),
        tone: 'warn',
      };
    case 'checking':
      return { value: v, sub: t('ui.mascot-theme.checking-for-updates'), tone: undefined };
    case 'error':
      return {
        value: v,
        sub:
          s.errorStage === 'download'
            ? t('ui.mascot-theme.update-download-failed')
            : s.errorStage === 'install'
              ? t('ui.mascot-theme.update-install-failed')
              : t('ui.chat-settings.update-check-failed'),
        tone: 'warn',
      };
    case 'unavailable':
      return {
        value: v,
        sub: t('ui.chat-settings.development-build-no-auto-update'),
        tone: undefined,
      };
    default:
      return { value: v, sub: t('ui.chat-settings.not-checked-yet'), tone: undefined };
  }
}

function usePref(): LocalePref {
  const [pref, setPref] = useState<LocalePref>(getLocalePref);
  useEffect(() => {
    const on = (e: Event) => setPref((e as CustomEvent<{ pref: LocalePref }>).detail.pref);
    window.addEventListener('cd:locale-changed', on);
    return () => window.removeEventListener('cd:locale-changed', on);
  }, []);
  return pref;
}

/**
 * 滚到页面里的某个设置并把焦点放过去（减少动态效果时直接跳）。只滚最近的可滚动容器：
 * scrollIntoView 会连窗口根元素一起滚，把侧栏顶出去。
 */
function jump(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  let box = el.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (box) {
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({ top: Math.max(0, top - 16), behavior: reduce ? 'auto' : 'smooth' });
  }
  el.querySelector<HTMLElement>('[role=radio][aria-checked=true], button, [tabindex="0"]')?.focus({
    preventScroll: true,
  });
}

const Cell: React.FC<{
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  tone?: Tone;
  target: string;
  testId: string;
}> = ({ icon, label, value, sub, tone, target, testId }) => (
  <button
    type="button"
    className={styles.cell}
    data-tone={tone}
    data-testid={testId}
    onClick={() => jump(target)}
  >
    <span className={styles.label}>
      <Icon icon={icon} size={14} />
      {label}
    </span>
    <span className={styles.value}>{value}</span>
    <span className={styles.sub}>{sub}</span>
  </button>
);

export const GeneralHero: React.FC = () => {
  const locale = useLocale();
  const pref = usePref();
  const [update] = useUpdateState();
  const theme = useThemeState();
  const ver = versionFacts(update);
  // 语言名始终用其本身的文字显示
  // i18n-ignore
  const langName = locale === 'zh-CN' ? '中文' : 'English';
  return (
    <section
      className={styles.hero}
      aria-label={t('ui.usage-tools.overview')}
      data-testid="settings-hero"
    >
      <div className={styles.strip}>
        <Cell
          icon={Sparkles}
          label={t('ui.foundation.version')}
          value={ver.value}
          sub={ver.sub}
          tone={ver.tone}
          target="settings-updates"
          testId="settings-hero-version"
        />
        <Cell
          icon={Palette}
          label={t('ui.chat-settings.theme')}
          value={themeLabel(theme)}
          sub={t('ui.chat-settings.appearance-theme-icon-and-chat-background')}
          target="settings-appearance"
          testId="settings-hero-theme"
        />
        <Cell
          icon={Globe}
          label={t('ui.voice-mascot.language')}
          value={pref === 'system' ? t('ui.mascot-theme.follow-system') : langName}
          sub={
            pref === 'system'
              ? t('ui.chat-settings.currently', langName)
              : t('ui.chat-settings.chat-nomi-and-notifications-follow-it')
          }
          target="settings-basic"
          testId="settings-hero-language"
        />
      </div>
    </section>
  );
};
