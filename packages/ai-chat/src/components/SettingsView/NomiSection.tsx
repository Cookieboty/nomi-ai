/**
 * 设置 →「Nomi」：Nomi 自己怎么做事，和编程助手（各 CLI 的版本 / 账号 / 新标签默认）分开。
 * 权限 = 工作区文件操作免确认、命令自动审核；委派 = Nomi 把任务交给哪个编程助手；
 * 工具权限 = 授权文件夹、各工具的确认策略、仅本地模型、活动日志（原「隐私与权限 → 桌面权限」）。
 */
import React from 'react';

import { DesktopPanel } from '../lazyPanels';
import { DelegateSettings } from '../ProvidersPage/DelegateSettings';

import { ArchivedChats } from './ArchivedChats';
import styles from './index.module.css';
import { NomiPermissionSettings } from './NomiPermissionSettings';
import { SectionPage } from './SectionPage';
import { SECTION_TABS, type NomiTab } from './sections';

const noop = () => undefined;

export const NomiSection: React.FC<{ tab: NomiTab; onTab: (tab: NomiTab) => void }> = ({
  tab,
  onTab,
}) => (
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
        <DelegateSettings />
      </div>
    )}
    {tab === 'tools' && <DesktopPanel key="desktop" isVisible onClose={noop} />}
    {tab === 'archived' && <ArchivedChats />}
  </SectionPage>
);
