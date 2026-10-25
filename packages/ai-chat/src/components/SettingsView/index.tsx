/**
 * 统一设置页（参考 Codex app 的 Settings：左侧分区导航，右侧内容）。
 * 各分区直接复用原有面板，通过 ModalHostContext 以「内嵌」方式渲染，功能与 test id 不变。
 */
import { Button, Icon, SettingRow, SettingsGroup, t } from '@nomi-ai/ui';
import { ModalHostContext } from '@nomi-ai/ui';
import { ChevronLeft, Lightbulb } from 'lucide-react';
import React, { Suspense, useEffect, useMemo, useState } from 'react';

import { harnessClient } from '../../services/harnessClient';
import { AppIcon } from '../AppIcons';
import { ExtensionsPanel, LocalPanel, QualityPanel, UsagePanel } from '../lazyPanels';
import { onboardingClient } from '../Onboarding/client';
import { ProvidersPage } from '../ProvidersPage';
import type { ScreenTab } from '../ScreenPanel';

import { AppIconSettings } from './AppIconSettings';
import { ChatBackgroundSettings } from './ChatBackgroundSettings';
import { GeneralHero } from './GeneralHero';
import styles from './index.module.css';
import { IslandSettings } from './IslandSettings';
import { KnowledgeSection } from './KnowledgeSection';
import { LanguageSettings } from './LanguageSettings';
import { LayoutDensitySettings } from './LayoutDensitySettings';
import { MascotSizeSettings } from './MascotSizeSettings';
import { NomiMark } from './NomiMark';
import { PrivacySection } from './PrivacySection';
import { ScheduleSection } from './ScheduleSection';
import { SECTION_HELP } from './sectionHelp';
import {
  LOCAL_MANAGE_TABS,
  SECTION_TABS,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTIONS,
  tabOf as pickTab,
  type SettingsSection,
  type SettingsTab,
} from './sections';
import { SensesSection } from './SensesSection';
import { ShortcutSettings } from './ShortcutSettings';
import { StartupSettings } from './StartupSettings';
import { ThemeSettings } from './ThemeSettings';
import { UpdateSettings } from './UpdateSettings';

export { SETTINGS_NAV_GROUPS, SETTINGS_SECTIONS, type SettingsSection, type SettingsTab };

/** 「模型」页懒加载 */
const ModelsPage = React.lazy(() =>
  import('../ModelsPage').then((m) => ({ default: m.ModelsPage })),
);

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
  // 宽分区（不显示右侧说明栏）的页头「说明」是否展开
  const [helpOpen, setHelpOpen] = useState(false);
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
  // 每个分区都有统一页头（标题 + 说明），内嵌面板自己的标题只留给读屏
  const inline = useMemo(() => ({ mode: 'inline' as const, hideTitle: true }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 子对话框打开时 Esc 交给它
      if (e.key === 'Escape' && !document.querySelector('.cd-modal-overlay')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const noop = () => undefined;
  const current = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0]!;
  const body = (() => {
    switch (section) {
      case 'general':
        return (
          <div className={styles.groups}>
            <GeneralHero />
            <SettingsGroup
              title={t('ui.chat-settings.appearance')}
              description={t('ui.chat-settings.theme-layout-app-icon-and-chat-background-applied')}
              id="settings-appearance"
              data-testid="settings-appearance"
            >
              <ThemeSettings />
              <LayoutDensitySettings />
              <AppIconSettings />
              <ChatBackgroundSettings />
            </SettingsGroup>
            <StartupSettings
              language={<LanguageSettings />}
              mascotSize={(shown) => <MascotSizeSettings disabled={!shown} />}
            />
            <UpdateSettings>
              <SettingRow
                title={t('ui.mascot-theme.getting-started-guide')}
                description={t(
                  'ui.chat-settings.go-through-it-again-language-theme-startup-layout',
                )}
              >
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="settings-reopen-onboarding"
                  onClick={() => {
                    onClose();
                    void onboardingClient.reopen();
                  }}
                >
                  {t('ui.chat-settings.reopen')}
                </Button>
              </SettingRow>
            </UpdateSettings>
          </div>
        );
      case 'shortcuts':
        return <ShortcutSettings />;
      case 'models':
        return (
          <Suspense fallback={null}>
            <ModelsPage />
          </Suspense>
        );
      case 'coding':
        return harnessClient.available() ? (
          <ProvidersPage
            onOpenedTab={onClose}
            onOpenNotify={() => onSection('notify')}
            onOpenModels={() => onSection('models')}
          />
        ) : (
          <p className={styles.note}>
            {t('ui.cli-monitor.coding-assistant-settings-are-only-available-in-the')}
          </p>
        );
      case 'quality':
        return (
          <QualityPanel
            tab={tabOf('quality')}
            onTab={(x) => setTab('quality', x)}
            onOpenPrivacy={() => go('privacy', 'data')}
          />
        );
      case 'usage':
        return <UsagePanel onOpenRequests={() => go('quality', 'requests')} />;
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
      <nav className={styles.nav} aria-label={t('ui.chat-settings.settings-sections')}>
        <div className={styles.brand} data-testid="settings-brand">
          <NomiMark className={styles.brandMark} />
          <span className={styles.brandText}>
            <span className={styles.brandName}>{t('ui.chat-settings.nomi')}</span>
            <span className={styles.brandSub}>
              {t('ui.chat-settings.your-desktop-ai-assistant')}
            </span>
          </span>
        </div>
        <button
          type="button"
          className={styles.back}
          onClick={onClose}
          data-testid="settings-back"
          title={t('ui.chat-settings.back-to-chat-esc')}
        >
          <Icon icon={ChevronLeft} />
          {t('ui.chat-settings.back-to-chat')}
        </button>
        {SETTINGS_NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={styles.navSection}>
            {group
              .map((id) => SETTINGS_SECTIONS.find((x) => x.id === id)!)
              .map((s) => (
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
          </div>
        ))}
      </nav>
      <main className={styles.content} aria-label={t(current.label)}>
        {section === 'general' && (
          // 「通用」页顶部横幅（纯装饰，读屏忽略）：铺满内容区顶部与两侧，四周渐隐进页面底色
          <img
            src="./brand/nomi-banner.webp"
            alt=""
            aria-hidden="true"
            className={styles.banner}
            data-testid="settings-banner"
            draggable={false}
          />
        )}
        <div
          className={[
            styles.inner,
            section === 'general' ? styles.innerAfterBanner : '',
            current.wide ? styles.innerWide : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {section === 'general' ? (
            <>
              <h1 className={styles.srOnly} data-testid="settings-section-title">
                {t(current.label)}
              </h1>
            </>
          ) : (
            <header className={styles.pageHead} data-testid="settings-page-head">
              <span className={styles.pageBadge} aria-hidden="true">
                <AppIcon icon={current.icon} size={22} />
              </span>
              <div className={styles.pageHeadText}>
                <h1 className={styles.pageTitle} data-testid="settings-section-title">
                  {t(current.label)}
                </h1>
                <p className={styles.pageIntro}>{t(current.intro)}</p>
              </div>
              {current.wide && (
                <button
                  type="button"
                  className={styles.helpToggle}
                  aria-expanded={helpOpen}
                  aria-controls="settings-help-inline"
                  onClick={() => setHelpOpen((o) => !o)}
                  data-testid="settings-help-toggle"
                >
                  <Icon icon={Lightbulb} size={14} />
                  {t('ui.chat-settings.about')}
                </button>
              )}
            </header>
          )}
          {current.wide && helpOpen && section !== 'general' && (
            <aside
              id="settings-help-inline"
              className={styles.helpInline}
              aria-label={t('ui.chat-settings.about-these-settings')}
              data-testid="settings-help-inline"
            >
              <ul className={styles.helpList}>
                {SECTION_HELP[section].map((h) => (
                  <li key={h.title} className={styles.helpItem}>
                    <span className={styles.helpIcon} aria-hidden="true">
                      <Icon icon={h.icon} size={15} />
                    </span>
                    <span>
                      <span className={styles.helpItemTitle}>{t(h.title)}</span>
                      <span className={styles.helpDesc}>{t(h.desc)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </aside>
          )}
          <div
            className={current.wide ? `${styles.columns} ${styles.columnsWide}` : styles.columns}
          >
            <div
              className={current.wide ? `${styles.mainCol} ${styles.mainColWide}` : styles.mainCol}
              data-testid="settings-main-col"
            >
              <ModalHostContext.Provider value={inline}>{body}</ModalHostContext.Provider>
            </div>
            {section !== 'general' && !current.wide && (
              <aside
                className={styles.help}
                aria-label={t('ui.chat-settings.about-these-settings')}
                data-testid="settings-help"
              >
                <h2 className={styles.helpTitle}>
                  <Icon icon={Lightbulb} size={16} />
                  {t('ui.chat-settings.about-these-settings')}
                </h2>
                <ul className={styles.helpList}>
                  {SECTION_HELP[section].map((h) => (
                    <li key={h.title} className={styles.helpItem}>
                      <span className={styles.helpIcon} aria-hidden="true">
                        <Icon icon={h.icon} size={15} />
                      </span>
                      <span>
                        <span className={styles.helpItemTitle}>{t(h.title)}</span>
                        <span className={styles.helpDesc}>{t(h.desc)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </aside>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
