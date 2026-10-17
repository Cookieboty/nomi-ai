/**
 * 设置 → 隐私与权限：
 * 「隐私与数据」= 数据只在本机的说明 + 管理 / 导出 / 清除的快捷入口（第一个标签）；
 * 「桌面权限」= 文件夹授权、工具权限、云端与仅本地开关与操作记录（桌面能力面板）。
 */
import { t } from '@nomi-ai/ui';
import React from 'react';

import { useAiChat } from '../../contexts/AiChatContext';
import { DesktopPanel } from '../lazyPanels';
import type { ScreenTab } from '../ScreenPanel';

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
  const { actions } = useAiChat();
  return (
    <SectionPage
      testId="settings-privacy-page"
      title="隐私与权限"
      tabsLabel="隐私与权限分区"
      intro={t(
        '数据怎么存、怎么导出和清除，以及 Nomi 能访问哪些文件夹、用哪些工具。所有内容都只保存在本机。',
      )}
      tabs={SECTION_TABS.privacy}
      value={tab}
      onChange={onTab}
    >
      {tab === 'data' ? (
        <section className={styles.block} data-testid="settings-privacy">
          <h2 className={styles.h2}>{t('隐私与数据')}</h2>
          <ul className={styles.list}>
            <li>{t('对话、记忆、知识库索引、屏幕记忆都只保存在这台电脑上，不做云同步。')}</li>
            <li>{t('编程助手进度只读取本机日志 / 状态文件，不登录、不抓取任何账号。')}</li>
            <li>{t('Token 用量与费用统计只存在本机，可随时关闭、设保留时长或一键清空。')}</li>
            <li>{t('屏幕记忆可随时暂停；桌面文件访问需逐个文件夹授权，操作都有记录可撤销。')}</li>
          </ul>
          <div className={styles.actions}>
            <button
              type="button"
              className="cd-btn cd-btn--sm"
              onClick={() => go('knowledge', 'memory')}
            >
              {t('管理记忆')}
            </button>
            <button
              type="button"
              className="cd-btn cd-btn--sm"
              onClick={() => go('senses', 'screen', 'privacy')}
            >
              {t('屏幕记忆与排除')}
            </button>
            <button type="button" className="cd-btn cd-btn--sm" onClick={() => onTab('desktop')}>
              {t('文件夹授权与操作记录')}
            </button>
            <button
              type="button"
              className="cd-btn cd-btn--sm"
              data-testid="privacy-usage"
              onClick={() => go('usage')}
            >
              {t('用量统计的隐私设置')}
            </button>
            <button
              type="button"
              className="cd-btn cd-btn--sm"
              data-testid="privacy-export"
              onClick={onExport}
            >
              {t('导出本地数据')}
            </button>
            <button
              type="button"
              className="cd-btn cd-btn--sm cd-btn--danger"
              data-testid="privacy-clear-chat"
              onClick={() => {
                if (window.confirm(t('清空当前对话的消息？（其它对话不受影响）')))
                  void actions.clearChatHistory();
              }}
            >
              {t('清空当前对话')}
            </button>
          </div>
        </section>
      ) : (
        <DesktopPanel key="desktop" isVisible onClose={noop} />
      )}
    </SectionPage>
  );
};
