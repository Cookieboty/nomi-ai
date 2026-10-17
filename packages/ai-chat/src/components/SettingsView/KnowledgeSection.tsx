/**
 * 设置 → 知识与记忆：用标签页容纳 知识库 / 长期记忆 / 笔记 三块（面板与交互不变）。知识库 = 你加入的文件夹与笔记的索引；长期记忆 = 从对话里沉淀的摘要 / 关于我 / 用户档案；
 * 笔记 = 本地 Markdown 笔记库（会被知识库一起索引）。三者都只存本机，提问时一起被检索，所以放在一页里统一说明。
 */
import { t } from '@nomi-ai/ui';
import React from 'react';

import { KnowledgePanel, MemoryPanel, NotesPanel } from '../lazyPanels';

import { SectionPage } from './SectionPage';
import { SECTION_TABS, type KnowledgeTab } from './sections';

const noop = () => undefined;

export const KnowledgeSection: React.FC<{
  tab: KnowledgeTab;
  onTab: (tab: KnowledgeTab) => void;
}> = ({ tab, onTab }) => (
  <SectionPage
    testId="settings-knowledge"
    title="知识与记忆"
    tabsLabel="知识与记忆分区"
    intro={t(
      '知识库来自你加入的文件夹和笔记，长期记忆来自你和 Nomi 的对话，笔记是你的本地 Markdown 笔记库；提问时它们会一起被检索，并在回答里标出引用。都只保存在本机。',
    )}
    tabs={SECTION_TABS.knowledge}
    value={tab}
    onChange={onTab}
  >
    {tab === 'kb' && <KnowledgePanel key="kb" isVisible onClose={noop} />}
    {tab === 'memory' && <MemoryPanel key="memory" isVisible onClose={noop} />}
    {tab === 'notes' && <NotesPanel key="notes" isVisible onClose={noop} />}
  </SectionPage>
);
