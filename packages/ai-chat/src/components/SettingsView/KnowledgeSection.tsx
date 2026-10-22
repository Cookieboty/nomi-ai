/**
 * 设置 → 知识与记忆：用标签页容纳 知识库 / 长期记忆 / 笔记 三块（面板与交互不变）。知识库 = 你加入的文件夹与笔记的索引；长期记忆 = 从对话里沉淀的摘要 / 关于我 / 用户档案；
 * 笔记 = 本地 Markdown 笔记库（会被知识库一起索引）。三者都只存本机，提问时一起被检索，所以放在一页里统一说明。
 */
import { ModalHostContext, type ModalHost } from '@nomi-ai/ui';
import React from 'react';

import { KnowledgePanel, MemoryPanel, NotesPanel } from '../lazyPanels';

import { SectionPage } from './SectionPage';
import { SECTION_TABS, type KnowledgeTab } from './sections';

const noop = () => undefined;
/** 标签已写明「知识库 / 长期记忆 / 笔记」，面板自己的标题只留给读屏 */
const HOST: ModalHost = { mode: 'inline', hideTitle: true };

export const KnowledgeSection: React.FC<{
  tab: KnowledgeTab;
  onTab: (tab: KnowledgeTab) => void;
}> = ({ tab, onTab }) => (
  <SectionPage
    testId="settings-knowledge"
    tabsLabel="知识与记忆分区"
    tabs={SECTION_TABS.knowledge}
    value={tab}
    onChange={onTab}
  >
    <ModalHostContext.Provider value={HOST}>
      {tab === 'kb' && <KnowledgePanel key="kb" isVisible onClose={noop} />}
      {tab === 'memory' && <MemoryPanel key="memory" isVisible onClose={noop} />}
      {tab === 'notes' && <NotesPanel key="notes" isVisible onClose={noop} />}
    </ModalHostContext.Provider>
  </SectionPage>
);
