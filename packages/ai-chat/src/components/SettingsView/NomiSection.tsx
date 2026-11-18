/**
 * 设置 →「Nomi」：Nomi 自己怎么做事，和 agent（各 CLI 的版本 / 账号 / 新标签默认）分开。
 * 权限 = 工作区文件操作免确认、命令自动审核；委派 = Nomi 把任务交给哪个 agent；
 * 工具权限 = 授权文件夹、各工具的确认策略、仅本地模型、活动日志（原「隐私与权限 → 桌面权限」）。
 */
import { Button, SettingRow, SettingsGroup, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { delegateClient } from '../../services/delegateClient';
import { DesktopPanel } from '../lazyPanels';

import { ArchivedChats } from './ArchivedChats';
import styles from './index.module.css';
import { NomiPermissionSettings } from './NomiPermissionSettings';
import { SectionPage } from './SectionPage';
import { SECTION_TABS, type NomiTab } from './sections';

const noop = () => undefined;

export const NomiSection: React.FC<{
  tab: NomiTab;
  onTab: (tab: NomiTab) => void;
  onOpenRouting?: () => void;
}> = ({ tab, onTab, onOpenRouting }) => {
  const [delegateEnabled, setDelegateEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (tab !== 'permissions' || !delegateClient.available()) return;
    let alive = true;
    delegateClient
      .settings()
      .then((v) => {
        if (alive) setDelegateEnabled(v.enabled);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [tab]);

  return (
    <SectionPage
      testId="settings-nomi"
      tabsLabel="ui.chat-settings.nomi-section-tabs"
      tabs={SECTION_TABS.nomi}
      value={tab}
      onChange={onTab}
    >
      {tab === 'permissions' && (
        <div className={styles.groups}>
          <NomiPermissionSettings />
          <SettingsGroup
            title={t('ui.chat-settings.handoff')}
            description={t('ui.chat-settings.nomi-can-hand-specific-coding-writing-review-and')}
            data-testid="nomi-handoff-summary"
          >
            <SettingRow
              title={t('ui.chat-settings.let-nomi-hand-off-tasks-to-coding-assistants')}
              description={t(
                delegateEnabled === false
                  ? 'ui.chat-settings.nomi-handoff-status-off'
                  : 'ui.chat-settings.nomi-handoff-status-on',
              )}
            >
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-testid="nomi-open-routing"
                onClick={onOpenRouting}
              >
                {t('ui.chat-settings.nomi-open-routing')}
              </Button>
            </SettingRow>
          </SettingsGroup>
        </div>
      )}
      {tab === 'tools' && <DesktopPanel key="desktop" isVisible onClose={noop} />}
      {tab === 'archived' && <ArchivedChats />}
    </SectionPage>
  );
};
