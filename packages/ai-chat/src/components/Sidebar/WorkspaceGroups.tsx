import { t, Icon, useLocale } from '@nomi-ai/ui';
import { Check, Ellipsis, Folder, FolderOpen, FolderTree, List, SquarePen } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { AnchoredPopover } from './AnchoredPopover';
import styles from './index.module.css';
import { SectionHeader } from './SectionHeader';
import { ThreadItem, type VirtualProps } from './SidebarRows';
import type { Meta } from './types';
import type { WorkspaceGroup } from './workspaceGrouping';

/** 「工作区」「最近」整个分区收起时记在折叠记录里的键（与工作区路径不会重名） */
export const SECTION_WORKSPACES = '\u0000section:workspaces';
export const SECTION_RECENT = '\u0000section:recent';
export const SECTION_PINNED = '\u0000section:pinned';

/** 每个工作区默认显示的会话数，其余点「展开显示」才出现 */
export const WORKSPACE_PREVIEW = 5;
/** 「最近」（没有工作区的会话）默认显示的条数 */
export const RECENT_PREVIEW = 20;

const Rows: React.FC<{ items: readonly Meta[]; activeId?: string; rows: VirtualProps }> = ({
  items,
  activeId,
  rows,
}) => (
  <>
    {items.map((c) => (
      <ThreadItem
        key={c.id}
        c={c}
        active={c.id === activeId}
        tab={c.tabId ? rows.tabById.get(c.tabId) : undefined}
        onOpen={rows.open}
        onCtx={rows.onCtx}
        renaming={rows.renamingId === c.id}
        onRename={rows.onRename}
        onPinToggle={rows.onPinToggle}
        onDeleteRequest={rows.onDeleteRequest}
        onMore={rows.onMore}
        onPeek={rows.onPeek}
        showIcon={rows.showIcon}
      />
    ))}
  </>
);

/** 每点一次「展开显示」多显示这么多条（分页加载）；全部显示后变成「收起」 */
export const PAGE_STEP = 5;

/** 「展开显示 / 收起」：shown 小于 total 时再加一页，否则收回到 base */
const MoreToggle: React.FC<{
  shown: number;
  total: number;
  onMore: () => void;
  onLess: () => void;
  testId: string;
}> = ({ shown, total, onMore, onLess, testId }) => {
  const all = shown >= total;
  return (
    <button
      type="button"
      className={styles.wsMore}
      aria-expanded={all}
      onClick={all ? onLess : onMore}
      data-testid={testId}
    >
      {all ? t('ui.knowledge-local.collapse') : t('ui.cli-monitor.show-more')}
    </button>
  );
};

/** 各列表当前显示几条（只在本次打开期间记住） */
function usePaging() {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const countOf = (key: string, base: number) => counts.get(key) ?? base;
  const more = (key: string, base: number) =>
    setCounts((m) => new Map(m).set(key, (m.get(key) ?? base) + PAGE_STEP));
  const less = (key: string) =>
    setCounts((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  return { countOf, more, less };
}

/** 最上面的「置顶」：置顶的会话不进工作区分组，按置顶先后排 */
export const PinnedSection: React.FC<{
  items: readonly Meta[];
  open: boolean;
  onToggle: (open: boolean) => void;
  activeId: string | undefined;
  rows: VirtualProps;
}> = ({ items, open, onToggle, activeId, rows }) => {
  useLocale();
  return (
    <div className={styles.wsRecent} data-testid="pinned-section">
      <SectionHeader
        label={t('ui.knowledge-local.pin-action')}
        open={open}
        onToggle={() => onToggle(open)}
        testId="pinned-section-toggle"
      />
      {open && <Rows items={items} activeId={activeId} rows={rows} />}
    </div>
  );
};

/**
 * 侧栏「按工作区」：每个工作区一个可折叠的文件夹，默认显示最近 5 条，其余自己展开；
 * 文件夹行上的「新建」在该工作区里开新会话。没有工作区的会话列在下面的「最近」里。
 */
export const WorkspaceGroups: React.FC<{
  groups: readonly WorkspaceGroup[];
  rest: readonly Meta[];
  collapsed: readonly string[];
  onToggleCollapsed: (key: string, collapsed: boolean) => void;
  onNewIn: (group: WorkspaceGroup) => void;
  activeId: string | undefined;
  /** 与平铺列表共用的行回调（items / current 不用） */
  rows: VirtualProps;
  /** 「工作区」标题右侧：整理「…」+ 新建「+」 */
  headerActions?: React.ReactNode;
}> = ({ groups, rest, collapsed, onToggleCollapsed, onNewIn, activeId, rows, headerActions }) => {
  useLocale();
  // 「展开显示」每次多显示一页，只在本次打开期间记住；折叠状态才持久化
  const paging = usePaging();
  const restKey = '\u0000recent';
  const restCount = paging.countOf(restKey, RECENT_PREVIEW);

  const wsOpen = !collapsed.includes(SECTION_WORKSPACES);
  const recentOpen = !collapsed.includes(SECTION_RECENT);
  return (
    <>
      {groups.length > 0 && (
        <SectionHeader
          label={t('ui.cli-monitor.workspaces')}
          open={wsOpen}
          onToggle={() => onToggleCollapsed(SECTION_WORKSPACES, wsOpen)}
          testId="workspace-section-toggle"
          actions={headerActions}
        />
      )}
      {wsOpen &&
        groups.map((g) => {
          const isCollapsed = collapsed.includes(g.key);
          const count = paging.countOf(g.key, WORKSPACE_PREVIEW);
          const shown = g.items.slice(0, count);
          const toggleLabel = isCollapsed
            ? t('ui.cli-monitor.expand-workspace', g.label)
            : t('ui.cli-monitor.collapse-workspace', g.label);
          const newLabel = t('ui.cli-monitor.new-chat-in-workspace', g.label);
          return (
            <div
              key={g.key}
              className={styles.wsGroup}
              role="group"
              aria-label={g.label}
              data-testid="workspace-group"
              data-workspace={g.key}
            >
              <div className={styles.wsHead}>
                <button
                  type="button"
                  className={styles.wsToggle}
                  aria-expanded={!isCollapsed}
                  aria-label={toggleLabel}
                  title={g.path}
                  onClick={() => onToggleCollapsed(g.key, !isCollapsed)}
                  data-testid="workspace-toggle"
                >
                  <Icon icon={isCollapsed ? Folder : FolderOpen} size={16} />
                  <span className={styles.wsLabel}>{g.label}</span>
                  {isCollapsed && <span className={styles.listCount}>{g.items.length}</span>}
                </button>
                <button
                  type="button"
                  className={styles.wsNew}
                  title={newLabel}
                  aria-label={newLabel}
                  onClick={() => onNewIn(g)}
                  data-testid="workspace-new-chat"
                >
                  <Icon icon={SquarePen} size={14} />
                </button>
              </div>
              {!isCollapsed && (
                <div className={styles.wsItems}>
                  <Rows items={shown} activeId={activeId} rows={rows} />
                  {g.items.length > WORKSPACE_PREVIEW && (
                    <MoreToggle
                      shown={count}
                      total={g.items.length}
                      onMore={() => paging.more(g.key, WORKSPACE_PREVIEW)}
                      onLess={() => paging.less(g.key)}
                      testId="workspace-show-more"
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      {rest.length > 0 && (
        <div className={styles.wsRecent} data-testid="workspace-recent">
          {/* 没有工作区分组时「最近」就是整张列表，不加标题、不能收起 */}
          {groups.length > 0 && (
            <SectionHeader
              label={t('ui.cli-monitor.recent-chats')}
              open={recentOpen}
              onToggle={() => onToggleCollapsed(SECTION_RECENT, recentOpen)}
              testId="recent-section-toggle"
            />
          )}
          {(recentOpen || groups.length === 0) && (
            <Rows items={rest.slice(0, restCount)} activeId={activeId} rows={rows} />
          )}
          {(recentOpen || groups.length === 0) && rest.length > RECENT_PREVIEW && (
            <MoreToggle
              shown={restCount}
              total={rest.length}
              onMore={() => paging.more(restKey, RECENT_PREVIEW)}
              onLess={() => paging.less(restKey)}
              testId="workspace-recent-more"
            />
          )}
        </div>
      )}
    </>
  );
};

/** 「工作区」标题右侧的「…」：整理侧栏——按工作区分组 / 合并成一张列表 */
export const OrganizeMenu: React.FC<{ grouped: boolean; onChange: (on: boolean) => void }> = ({
  grouped,
  onChange,
}) => {
  useLocale();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node;
      if (!ref.current?.contains(el) && !popRef.current?.contains(el)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const pick = (on: boolean) => {
    setOpen(false);
    if (on !== grouped) onChange(on);
  };
  const item = (on: boolean, icon: typeof FolderTree, label: string, testId: string) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={grouped === on}
      className={styles.orgItem}
      onClick={() => pick(on)}
      data-testid={testId}
    >
      <Icon icon={icon} size={14} />
      <span className={styles.orgLabel}>{label}</span>
      {grouped === on && <Icon icon={Check} size={14} />}
    </button>
  );
  return (
    <span className={styles.orgWrap} ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className={styles.headBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('ui.cli-monitor.organize-sidebar')}
        aria-label={t('ui.cli-monitor.organize-sidebar')}
        onClick={() => setOpen((v) => !v)}
        data-testid="organize-sidebar"
      >
        <Icon icon={Ellipsis} size={14} />
      </button>
      {open && (
        <AnchoredPopover anchor={btnRef.current} popRef={popRef}>
          <div
            className={styles.orgMenu}
            role="menu"
            aria-label={t('ui.cli-monitor.organize-sidebar')}
          >
            <div className={styles.orgTitle}>{t('ui.cli-monitor.organize-sidebar')}</div>
            {item(true, FolderTree, t('ui.cli-monitor.group-by-workspace'), 'group-by-workspace')}
            {item(false, List, t('ui.cli-monitor.merged-list'), 'merged-list')}
          </div>
        </AnchoredPopover>
      )}
    </span>
  );
};
