/**
 * 统一设置页（参考 Codex app 的 Settings：左侧分区导航，右侧内容）。
 * 各分区直接复用原有面板，通过 ModalHostContext 以「内嵌」方式渲染，功能与 test id 不变。
 */
import { t, Icon } from '@nomi-ai/ui';
import { ModalHostContext } from '@nomi-ai/ui';
import { ChevronLeft } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import { cliProviderClient } from '../../services/cliProviderClient';
import { providerClientAvailable } from '../../services/providerClient';
import { AppIcon } from '../AppIcons';
import { ConfigPanel, ExtensionsPanel, LocalPanel, UsagePanel } from '../lazyPanels';
import { onboardingClient } from '../Onboarding/client';
import { ProvidersPage } from '../ProvidersPage';
import type { ScreenTab } from '../ScreenPanel';

import { AppIconSettings } from './AppIconSettings';
import styles from './index.module.css';
import { IslandSettings } from './IslandSettings';
import { KnowledgeSection } from './KnowledgeSection';
import { LanguageSettings } from './LanguageSettings';
import { MascotSizeSettings } from './MascotSizeSettings';
import { PinsSettings } from './PinsSettings';
import { PrivacySection } from './PrivacySection';
import { ScheduleSection } from './ScheduleSection';
import {
  LOCAL_MANAGE_TABS,
  SECTION_TABS,
  SETTINGS_SECTIONS,
  tabOf as pickTab,
  type SettingsSection,
  type SettingsTab,
} from './sections';
import { SensesSection } from './SensesSection';
import { ShortcutSettings } from './ShortcutSettings';
import { ThemeSettings } from './ThemeSettings';
import { UpdateSettings } from './UpdateSettings';

export { SETTINGS_SECTIONS, type SettingsSection, type SettingsTab };

interface Props {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onClose: () => void;
  /**
   * 深链接指定的标签（如从快速视图抽屉「在设置中打开」跳到「知识与记忆 → 长期记忆」）。
   * 每次新建一个对象表示一次新的跳转；不传则用各分区的第一个标签。
   */
  deepLink?: { tab?: SettingsTab };
}

type TabState = Partial<Record<keyof typeof SECTION_TABS, string>>;

export const SettingsView: React.FC<Props> = ({ section, onSection, onClose, deepLink }) => {
  // 站内跳转指定的「屏幕」内层标签；从侧栏进入其它分区时清掉
  const [screenSub, setScreenSub] = useState<ScreenTab | undefined>();
  const [localTab, setLocalTab] = useState<'export' | undefined>();
  // 有标签页的分区各自记住当前标签（离开设置页后重置）
  const [tabs, setTabs] = useState<TabState>(() =>
    deepLink?.tab && section in SECTION_TABS ? { [section]: deepLink.tab } : {},
  );
  // 新的深链接（App 每次跳转传一个新对象）：在渲染期同步到对应分区的标签
  const [seenLink, setSeenLink] = useState(deepLink);
  if (deepLink !== seenLink) {
    setSeenLink(deepLink);
    if (deepLink?.tab && section in SECTION_TABS)
      setTabs((p) => ({ ...p, [section]: deepLink.tab }));
  }
  const tabOf = <S extends keyof typeof SECTION_TABS>(s: S) =>
    pickTab(s, tabs[s]) ?? (SECTION_TABS[s][0].id as (typeof SECTION_TABS)[S][number]['id']);
  const setTab = (s: keyof typeof SECTION_TABS, tab: string) =>
    setTabs((p) => ({ ...p, [s]: tab }));
  /** 站内跳转：可同时指定目标分区的标签 */
  const go = (s: SettingsSection, tab?: SettingsTab, sub?: ScreenTab) => {
    if (tab && s in SECTION_TABS) setTab(s as keyof typeof SECTION_TABS, tab);
    setScreenSub(sub);
    onSection(s);
  };
  const inline = useMemo(() => ({ mode: 'inline' as const }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 子对话框打开时 Esc 交给它
      if (e.key === 'Escape' && !document.querySelector('.cd-modal-overlay')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const noop = () => undefined;
  const body = (() => {
    switch (section) {
      case 'general':
        return (
          <>
            <LanguageSettings />
            <AppIconSettings />
            <MascotSizeSettings />
            <UpdateSettings />
            <section className={styles.block}>
              <h2 className={styles.h2}>{t('新手引导')}</h2>
              <p className={styles.muted}>
                {t('重新走一遍：语言、主题、角色与声音、称呼与语气、模型供应商和隐私说明。')}
              </p>
              <button
                type="button"
                className={styles.lang}
                data-testid="settings-reopen-onboarding"
                onClick={() => {
                  onClose();
                  void onboardingClient.reopen();
                }}
              >
                {t('重新打开新手引导')}
              </button>
            </section>
            <ThemeSettings />
            <PinsSettings />
            <ConfigPanel isVisible onClose={noop} />
          </>
        );
      case 'shortcuts':
        return <ShortcutSettings />;
      case 'coding':
        return providerClientAvailable() || cliProviderClient.available() ? (
          <ProvidersPage onOpenedTab={onClose} onOpenNotify={() => onSection('notify')} />
        ) : (
          <p className={styles.note}>{t('编程助手设置仅在桌面应用中可用；模型配置见「通用」。')}</p>
        );
      case 'usage':
        return <UsagePanel />;
      case 'senses':
        return (
          <SensesSection
            tab={tabOf('senses')}
            onTab={(x) => setTab('senses', x)}
            screenTab={screenSub}
          />
        );
      case 'knowledge':
        return <KnowledgeSection tab={tabOf('knowledge')} onTab={(x) => setTab('knowledge', x)} />;
      case 'schedule':
        return <ScheduleSection tab={tabOf('schedule')} onTab={(x) => setTab('schedule', x)} />;
      case 'notify':
        return <IslandSettings />;
      case 'ext':
        return <ExtensionsPanel isVisible onClose={noop} />;
      case 'local':
        return (
          <LocalPanel
            key={localTab ?? 'first'}
            isVisible
            onClose={noop}
            initialTab={localTab}
            tabs={[...LOCAL_MANAGE_TABS]}
          />
        );
      case 'privacy':
        return (
          <PrivacySection
            tab={tabOf('privacy')}
            onTab={(x) => setTab('privacy', x)}
            go={go}
            onExport={() => {
              setLocalTab('export');
              onSection('local');
            }}
          />
        );
    }
  })();

  return (
    <div className={styles.settings} data-testid="settings-view">
      <nav className={styles.nav} aria-label={t('设置分区')}>
        <button
          type="button"
          className={styles.back}
          onClick={onClose}
          data-testid="settings-back"
          title={t('返回对话 (Esc)')}
        >
          <Icon icon={ChevronLeft} />
          {t('返回对话')}
        </button>
        <div className={styles.navTitle}>{t('设置')}</div>
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`${styles.navItem} ${s.id === section ? styles.navActive : ''}`}
            aria-current={s.id === section ? 'page' : undefined}
            onClick={() => {
              setLocalTab(undefined);
              setScreenSub(undefined);
              onSection(s.id);
            }}
            data-testid={`settings-nav-${s.id}`}
          >
            <span className={styles.navIcon}>
              <AppIcon icon={s.icon} size="nav" />
            </span>
            {t(s.label)}
          </button>
        ))}
      </nav>
      <main className={styles.content}>
        <div className={styles.inner}>
          <ModalHostContext.Provider value={inline}>{body}</ModalHostContext.Provider>
        </div>
      </main>
    </div>
  );
};
