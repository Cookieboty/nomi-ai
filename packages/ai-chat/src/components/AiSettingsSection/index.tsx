/**
 * 设置 →「模型与 Agents」合并视图：
 * - routing：任务与成本路由（预设档位卡片、复杂度/分类路由表、Nomi 与全局轻量模型）
 * - assistants：Agents 与账号（CliLauncherCard + OfficialAccounts 并存、CliThirdPartyModelsCard 就地选模型）
 * - providers：三方模型（ModelsPage 去分配表格）
 * - local：本地模型（内嵌 LocalPanel）
 * - monitor：监视与会话（CodingMonitor）
 */
import { t } from '@nomi-ai/ui';
import React, { Suspense } from 'react';

import { harnessClient } from '../../services/harnessClient';
import { CodingMonitor } from '../CodingMonitor';
import { LocalPanel } from '../lazyPanels';
import { ProvidersPage } from '../ProvidersPage';
import { SectionPage } from '../SettingsView/SectionPage';
import {
  SECTION_TABS,
  type AiTab,
  type SettingsSection,
  type SettingsTab,
} from '../SettingsView/sections';

import styles from './index.module.css';
import { RoutingTab } from './RoutingTab';

const ModelsPage = React.lazy(() =>
  import('../ModelsPage').then((m) => ({ default: m.ModelsPage })),
);

const noop = () => undefined;

export const AiSettingsSection: React.FC<{
  tab: AiTab;
  onTab: (tab: AiTab) => void;
  onClose: () => void;
  go: (s: SettingsSection, tab?: SettingsTab) => void;
}> = ({ tab, onTab, onClose, go }) => (
  <SectionPage
    testId="settings-ai-page"
    tabsLabel="ui.chat-settings.models-and-coding-sections"
    tabs={SECTION_TABS.ai}
    value={tab}
    onChange={onTab}
  >
    {tab === 'routing' && <RoutingTab onOpenProviders={() => onTab('providers')} />}
    {tab === 'assistants' &&
      (harnessClient.available() ? (
        <ProvidersPage
          hideViewTabs
          onOpenedTab={onClose}
          onOpenNotify={() => go('general', 'notify')}
          onOpenModels={() => onTab('providers')}
        />
      ) : (
        <p className={styles.note}>
          {t('ui.cli-monitor.coding-assistant-settings-are-only-available-in-the')}
        </p>
      ))}
    {tab === 'providers' && (
      <div data-testid="ai-providers-tab">
        <Suspense fallback={null}>
          <ModelsPage hideAssignments />
        </Suspense>
      </div>
    )}
    {tab === 'local' && (
      <div data-testid="ai-local-tab">
        <LocalPanel isVisible onClose={noop} tabs={['models']} />
      </div>
    )}
    {tab === 'monitor' &&
      (harnessClient.available() ? (
        <div data-testid="providers-section-monitor">
          <CodingMonitor onOpenedTab={onClose} onOpenNotify={() => go('general', 'notify')} />
        </div>
      ) : (
        <p className={styles.note}>
          {t('ui.cli-monitor.coding-assistant-settings-are-only-available-in-the')}
        </p>
      ))}
  </SectionPage>
);
