/**
 * 设置 → 知识与记忆：用标签页容纳 知识库 / 长期记忆 / 日程（面板与交互不变）。知识库 = 你加入的文件夹的索引；
 * 长期记忆 = 从对话里沉淀的摘要 / 关于我 / 用户档案；日程 = 提醒、定时任务、主动聊天与免打扰。
 * 都只存本机；每日简报会结合提醒与长期记忆，所以放在一页里。
 */
import React from 'react';

import { KnowledgePanel, MemoryPanel, SchedulePanel } from '../lazyPanels';

import { SectionPage } from './SectionPage';
import { SECTION_TABS, type KnowledgeTab } from './sections';

const noop = () => undefined;

export const KnowledgeSection: React.FC<{
  tab: KnowledgeTab;
  onTab: (tab: KnowledgeTab) => void;
}> = ({ tab, onTab }) => (
  <SectionPage
    testId="settings-knowledge"
    tabsLabel="ui.chat-settings.knowledge-and-memory-sections"
    tabs={SECTION_TABS.knowledge}
    value={tab}
    onChange={onTab}
  >
    {tab === 'kb' && <KnowledgePanel key="kb" isVisible onClose={noop} />}
    {tab === 'memory' && <MemoryPanel key="memory" isVisible onClose={noop} />}
    {tab === 'schedule' && (
      <div data-testid="settings-schedule">
        <SchedulePanel key="schedule" isVisible onClose={noop} />
      </div>
    )}
  </SectionPage>
);
