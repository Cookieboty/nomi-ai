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
  listLabel: string;
  listOpen: boolean;
  onToggleList: () => void;
  ordered: Meta[];
  tabById: Map<string, HarnessTabMeta>;
  runningIds: Set<string>;
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
  listLabel,
  listOpen,
  onToggleList,
  ordered,
  tabById,
  runningIds,
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
        hideEmpty={isDev && view === 'by-endpoint'}
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
      <div style={{ height: '100%', minHeight: 320 }} data-testid="conversation-list-virtual">
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
