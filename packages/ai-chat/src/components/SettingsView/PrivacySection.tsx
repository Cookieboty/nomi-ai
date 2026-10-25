/**
 * 设置 → 隐私与权限：
 * 「隐私与数据」= 数据只在本机的说明 + 管理 / 导出 / 清除的快捷入口（第一个标签）；
 * 「桌面权限」= 文件夹授权、工具权限、云端与仅本地开关与操作记录（桌面能力面板）。
 */
import { Button, SettingRow, SettingsGroup, t } from '@nomi-ai/ui';
import React from 'react';

import { useAiChatActions } from '../../contexts/aiChatStore';
import { DesktopPanel } from '../lazyPanels';
import type { ScreenTab } from '../ScreenPanel';

import { DiagnosticsSettings } from './DiagnosticsSettings';
import styles from './index.module.css';
import { SectionPage } from './SectionPage';
import { SECTION_TABS, type PrivacyTab, type SettingsSection, type SettingsTab } from './sections';

const noop = () => undefined;

export const PrivacySection: React.FC<{
  tab: PrivacyTab;
  onTab: (tab: PrivacyTab) => void;
  /** 跳到别的分区（可带标签） */
  go: (section: SettingsSection, tab?: SettingsTab, sub?: ScreenTab) => void;
  onExport: () => void;
}> = ({ tab, onTab, go, onExport }) => {
  const { actions } = useAiChatActions();
  return (
    <SectionPage
      testId="settings-privacy-page"
      tabsLabel="ui.chat-settings.privacy-and-permissions-sections"
      tabs={SECTION_TABS.privacy}
      value={tab}
      onChange={onTab}
    >
      {tab === 'data' ? (
        <div className={styles.groups} data-testid="settings-privacy">
          <SettingsGroup
            title={t('ui.knowledge-local.your-data-stays-on-this-device')}
            description={t('ui.knowledge-local.nomi-doesn-t-sync-to-the-cloud-jump')}
          >
            <SettingRow
              title={t('ui.knowledge-local.chats-and-memory')}
              description={t('ui.knowledge-local.chats-memories-and-the-knowledge-base-index-are')}
            >
              <Button size="sm" onClick={() => go('knowledge', 'memory')}>
                {t('ui.chat-settings.manage-memory')}
              </Button>
            </SettingRow>
            <SettingRow
              title={t('ui.chat-settings.screen-memory')}
              description={t('ui.knowledge-local.stored-on-this-device-only-can-be-paused')}
            >
              <Button size="sm" onClick={() => go('senses', 'screen', 'privacy')}>
                {t('ui.chat-settings.screen-memory-exclusions')}
              </Button>
            </SettingRow>
            <SettingRow
              title={t('ui.knowledge-local.desktop-files')}
              description={t('ui.knowledge-local.each-folder-must-be-authorized-every-action-is')}
            >
              <Button size="sm" onClick={() => onTab('desktop')}>
                {t('ui.chat-settings.folder-grants-activity-log')}
              </Button>
            </SettingRow>
            <SettingRow
              title={t('ui.usage-tools.usage-cost')}
              description={t('ui.usage-tools.token-usage-and-cost-statistics-stay-on-this')}
            >
              <Button size="sm" data-testid="privacy-usage" onClick={() => go('usage')}>
                {t('ui.usage-tools.usage-privacy-settings')}
              </Button>
            </SettingRow>
            <SettingRow
              title={t('ui.providers-schedule.coding-agents')}
              description={t('ui.chat-settings.coding-agent-progress-only-reads-local-logs-status')}
            />
          </SettingsGroup>
          <SettingsGroup title={t('ui.knowledge-local.export-clear')}>
            <SettingRow
              title={t('ui.chat-settings.export-local-data')}
              description={t('ui.knowledge-local.pack-chats-memories-schedules-and-more-into-a')}
            >
              <Button size="sm" data-testid="privacy-export" onClick={onExport}>
                {t('ui.knowledge-local.export')}
              </Button>
            </SettingRow>
            <SettingRow
              title={t('ui.chat-settings.clear-current-conversation')}
              description={t('ui.knowledge-local.deletes-only-the-current-chat-s-messages-other')}
            >
              <Button
                size="sm"
                variant="danger"
                data-testid="privacy-clear-chat"
                onClick={() => {
                  if (
                    window.confirm(
                      t(
                        'ui.chat-settings.clear-messages-in-the-current-conversation-other-conversations',
                      ),
                    )
                  )
                    void actions.clearChatHistory();
                }}
              >
                {t('ui.knowledge-local.clear')}
              </Button>
            </SettingRow>
          </SettingsGroup>
          <DiagnosticsSettings />
        </div>
      ) : (
        <DesktopPanel key="desktop" isVisible onClose={noop} />
      )}
    </SectionPage>
  );
};
