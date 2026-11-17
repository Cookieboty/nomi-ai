import React from 'react';
import { List } from 'react-window';

import type { ConversationListView } from '../../services/chatPrefs';
import type { HarnessTabMeta } from '../../services/harnessClient';
import type { HistoryBackend, HistorySession } from '../../services/historyClient';

import styles from './index.module.css';
import { LocalHistorySection } from './LocalHistorySection';
import { ProjectGroups } from './ProjectGroups';
import { SectionHeader } from './SectionHeader';
import { ThreadItem, VirtualRow, type VirtualProps } from './SidebarRows';
import type { Meta } from './types';

type Groups = React.ComponentProps<typeof ProjectGroups>;

interface SidebarThreadsProps {
  grouped: boolean;
  wsGroups: Pick<Groups, 'groups' | 'rest'>;
  collapsedWorkspaces: readonly string[];
  onToggleCollapsed: Groups['onToggleCollapsed'];
  onNewIn: Groups['onNewIn'];
  onEdit: Groups['onEdit'];
  activeId?: string;
  rows: VirtualProps;
  headerActions: React.ReactNode;
  isDev: boolean;
  view: ConversationListView;
  bins: Record<string, string | null>;
  onProjectPeek?: Groups['onProjectPeek'];
  onHideProjectPeek?: Groups['onHideProjectPeek'];
  listLabel: string;
  listOpen: boolean;
  onToggleList: () => void;
  ordered: Meta[];
  tabById: Map<string, HarnessTabMeta>;
  runningIds: Set<string>;
  /** 刚跑完一轮、还没点进去看的 Nomi 会话 id */
  doneIds: Set<string>;
  renamingId: string | null;
  showIcon: boolean;
  histVisible: boolean;
  histItems: HistorySession[];
  histScanning: boolean;
  openingKey: string | null;
  onOpenHistory: (h: HistorySession) => void;
  onHistMenu: (h: HistorySession, x: number, y: number, anchor?: HTMLElement) => void;
  histScope: HistoryBackend | undefined;
  histScopeSupported: boolean;
  hasMore: boolean;
  historyLoading: boolean;
  onLoadMore: () => void;
  onRefreshHistory: () => void;
}

/** 会话列表正文：项目分组 / 平铺列表 / 虚拟列表 / 本机历史分页 */
export const SidebarThreads: React.FC<SidebarThreadsProps> = ({
  grouped,
  wsGroups,
  collapsedWorkspaces,
  onToggleCollapsed,
  onNewIn,
  onEdit,
  activeId,
  rows,
  headerActions,
  isDev,
  view,
  bins,
  onProjectPeek,
  onHideProjectPeek,
  listLabel,
  listOpen,
  onToggleList,
  ordered,
  tabById,
  runningIds,
  doneIds,
  renamingId,
  showIcon,
  histVisible,
  histItems,
  histScanning,
  openingKey,
  onOpenHistory,
  onHistMenu,
  histScopeSupported,
  hasMore,
  historyLoading,
  onLoadMore,
  onRefreshHistory,
}) => (
  <>
    {grouped && (
      <ProjectGroups
        groups={wsGroups.groups}
        rest={wsGroups.rest}
        collapsed={collapsedWorkspaces}
        onToggleCollapsed={onToggleCollapsed}
        onNewIn={onNewIn}
        onEdit={onEdit}
        activeId={activeId}
        rows={rows}
        headerActions={headerActions}
        canPickBackend={isDev && view === 'all'}
        bins={bins}
        onProjectPeek={onProjectPeek}
        onHideProjectPeek={onHideProjectPeek}
      />
    )}
    {!grouped && (
      <SectionHeader
        label={listLabel}
        open={listOpen}
        onToggle={onToggleList}
        testId="list-section-toggle"
        actions={headerActions}
      />
    )}
    {!grouped &&
      listOpen &&
      ordered.length > 0 &&
      ordered.length <= 100 &&
      ordered.map((c) => (
        <ThreadItem
          key={c.id}
          c={c}
          active={c.id === activeId}
          tab={c.tabId ? tabById.get(c.tabId) : undefined}
          running={c.tabId ? undefined : runningIds.has(c.id)}
          done={c.tabId ? undefined : doneIds.has(c.id)}
          onOpen={rows.open}
          onCtx={rows.onCtx}
          renaming={renamingId === c.id}
          onRename={rows.onRename}
          onPinToggle={rows.onPinToggle}
          onMore={rows.onMore}
          onPeek={rows.onPeek}
          showIcon={showIcon}
        />
      ))}
    {!grouped && listOpen && ordered.length > 100 && (
      /*
       * 超长列表（> 100）交给 react-window 只渲染可视行。
       * 容器取「剩余高度」而不是 height:100%：上面还有分区标题等兄弟节点，
       * 写 100% 会连它们的高度一起算进来，把内容顶出可视区；
       * 外层 .threads 此时是 overflow: hidden（滚动交给内部 List），溢出的部分既滚不到也点不到。
       */
      <div className={styles.virtualHost} data-testid="conversation-list-virtual">
        <List
          rowCount={ordered.length}
          rowHeight={34}
          className={styles.virtualList}
          rowComponent={VirtualRow}
          rowProps={rows}
          style={{ height: '100%', width: '100%' }}
        />
      </div>
    )}
    {histVisible && (histItems.length > 0 || histScanning) && (
      <LocalHistorySection
        items={histItems}
        scanning={histScanning}
        openingKey={openingKey}
        onOpen={onOpenHistory}
        onMenu={onHistMenu}
        hasMore={histScopeSupported && hasMore}
        loading={historyLoading}
        onLoadMore={onLoadMore}
        onRefresh={onRefreshHistory}
      />
    )}
  </>
);
