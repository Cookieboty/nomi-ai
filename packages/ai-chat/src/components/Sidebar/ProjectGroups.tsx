import { t, Icon, useLocale, usePresence } from '@nomi-ai/ui';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderTree,
  List,
  SquarePen,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { AnchoredPopover } from './AnchoredPopover';
import styles from './index.module.css';
import type { ProjectGroup } from './projectGrouping';
import ws from './ProjectGroups.module.css';
import { SectionHeader } from './SectionHeader';
import { ThreadItem, type VirtualProps } from './SidebarRows';
import type { Meta } from './types';

/** 「项目」「其他对话」整个分区收起时记在折叠记录里的键（与项目 id 不会重名） */
export const SECTION_WORKSPACES = '\u0000section:workspaces';
export const SECTION_RECENT = '\u0000section:recent';
export const SECTION_PINNED = '\u0000section:pinned';

/** 每个项目默认显示的会话数，其余点「展开显示」才出现 */
export const WORKSPACE_PREVIEW = 5;
/** 「其他对话」（没有项目的会话）默认显示的条数 */
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

/**
 * 「再显示 N 条 / 收起」：shown 小于 total 时再加一页，否则收回到 base。
 * 小号浅色、带箭头，和会话行区分开（不像一条叫「展开显示」的会话）。
 */
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
      className={ws.wsMore}
      aria-expanded={all}
      onClick={all ? onLess : onMore}
      data-testid={testId}
    >
      <span>
        {all
          ? t('ui.knowledge-local.collapse')
          : t('ui.cli-monitor.show-n-more', Math.min(PAGE_STEP, total - shown))}
      </span>
      <Icon icon={all ? ChevronUp : ChevronDown} size={12} />
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

/** 最上面的「置顶」：置顶的会话不进项目分组，按置顶先后排 */
export const PinnedSection: React.FC<{
  items: readonly Meta[];
  open: boolean;
  onToggle: (open: boolean) => void;
  activeId: string | undefined;
  rows: VirtualProps;
}> = ({ items, open, onToggle, activeId, rows }) => {
  useLocale();
  return (
    <div className={ws.wsRecent} data-testid="pinned-section">
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
 * 侧栏「按项目」：每个项目一个可折叠的文件夹（没有会话的项目也在；「按端」看时只列这个端有会话的项目），
 * 默认显示最近 5 条，其余自己展开；项目行上的「…」编辑项目，「新建」在该项目里开新会话。
 * 没有项目的会话列在下面的「其他对话」里。
 */
export const ProjectGroups: React.FC<{
  groups: readonly ProjectGroup[];
  rest: readonly Meta[];
  collapsed: readonly string[];
  onToggleCollapsed: (key: string, collapsed: boolean) => void;
  onNewIn: (group: ProjectGroup) => void;
  onEdit: (group: ProjectGroup) => void;
  activeId: string | undefined;
  /** 与平铺列表共用的行回调（items / current 不用） */
  rows: VirtualProps;
  /** 「项目」标题右侧：整理「…」+ 新建项目 */
  headerActions?: React.ReactNode;
  /** 只看一个端时：这个端在项目里一个会话都没有的项目不列出来 */
  hideEmpty?: boolean;
}> = ({
  groups,
  rest,
  collapsed,
  onToggleCollapsed,
  onNewIn,
  onEdit,
  activeId,
  rows,
  headerActions,
  hideEmpty,
}) => {
  useLocale();
  // 「展开显示」每次多显示一页，只在本次打开期间记住；折叠状态才持久化
  const paging = usePaging();
  const restKey = '\u0000recent';
  const restCount = paging.countOf(restKey, RECENT_PREVIEW);

  const shownGroups = hideEmpty ? groups.filter((g) => g.items.length > 0) : groups;
  const wsOpen = !collapsed.includes(SECTION_WORKSPACES);
  const recentOpen = !collapsed.includes(SECTION_RECENT);
  return (
    <>
      <SectionHeader
        label={t('ui.slash-commands.project')}
        open={wsOpen}
        onToggle={() => onToggleCollapsed(SECTION_WORKSPACES, wsOpen)}
        testId="workspace-section-toggle"
        actions={headerActions}
      />
      {wsOpen && shownGroups.length === 0 && (
        <div className={ws.wsEmpty} data-testid="projects-empty">
          {t('ui.cli-monitor.project-none-yet')}
        </div>
      )}
      {wsOpen &&
        shownGroups.map((g) => {
          const isCollapsed = collapsed.includes(g.key);
          const count = paging.countOf(g.key, WORKSPACE_PREVIEW);
          const shown = g.items.slice(0, count);
          const name = g.project.name;
          const toggleLabel = isCollapsed
            ? t('ui.cli-monitor.expand-workspace', name)
            : t('ui.cli-monitor.collapse-workspace', name);
          const newLabel = t('ui.cli-monitor.new-chat-in-project', name);
          const editLabel = t('ui.cli-monitor.project-edit', name);
          return (
            <div
              key={g.key}
              className={ws.wsGroup}
              role="group"
              aria-label={name}
              data-testid="workspace-group"
              data-project={g.key}
              data-missing={g.project.missing?.length ? true : undefined}
            >
              <div className={ws.wsHead}>
                <button
                  type="button"
                  className={ws.wsToggle}
                  aria-expanded={!isCollapsed}
                  aria-label={toggleLabel}
                  title={g.title}
                  onClick={() => onToggleCollapsed(g.key, !isCollapsed)}
                  data-testid="workspace-toggle"
                >
                  <Icon icon={isCollapsed ? Folder : FolderOpen} size={16} />
                  <span className={ws.wsLabel}>{name}</span>
                  {isCollapsed && g.items.length > 0 && (
                    <span className={styles.listCount}>{g.items.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={ws.wsNew}
                  title={editLabel}
                  aria-label={editLabel}
                  onClick={() => onEdit(g)}
                  data-testid="project-edit"
                >
                  <Icon icon={Ellipsis} size={14} />
                </button>
                <button
                  type="button"
                  className={ws.wsNew}
                  title={newLabel}
                  aria-label={newLabel}
                  onClick={() => onNewIn(g)}
                  data-testid="workspace-new-chat"
                >
                  <Icon icon={SquarePen} size={14} />
                </button>
              </div>
              {!isCollapsed && (
                <div className={ws.wsItems}>
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
      {/* 「其他对话」一直在：不在任何项目里的会话 */}
      {
        <div className={ws.wsRecent} data-testid="workspace-recent">
          <SectionHeader
            label={t('ui.cli-monitor.other-chats')}
            open={recentOpen}
            onToggle={() => onToggleCollapsed(SECTION_RECENT, recentOpen)}
            testId="recent-section-toggle"
          />
          {recentOpen && <Rows items={rest.slice(0, restCount)} activeId={activeId} rows={rows} />}
          {recentOpen && rest.length > RECENT_PREVIEW && (
            <MoreToggle
              shown={restCount}
              total={rest.length}
              onMore={() => paging.more(restKey, RECENT_PREVIEW)}
              onLess={() => paging.less(restKey)}
              testId="workspace-recent-more"
            />
          )}
        </div>
      }
    </>
  );
};

/** 「项目」标题右侧的「…」：整理侧栏——按项目分组 / 合并成一张列表 */
export const OrganizeMenu: React.FC<{ grouped: boolean; onChange: (on: boolean) => void }> = ({
  grouped,
  onChange,
}) => {
  useLocale();
  const [open, setOpen] = useState(false);
  // 收起时先放完淡出动画再卸载
  const menuP = usePresence(open);
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
      {menuP.value && (
        <AnchoredPopover anchor={btnRef.current} popRef={popRef}>
          <div
            className={`${styles.orgMenu} cd-motion-pop`}
            data-closing={menuP.closing || undefined}
            role="menu"
            aria-label={t('ui.cli-monitor.organize-sidebar')}
          >
            <div className={styles.orgTitle}>{t('ui.cli-monitor.organize-sidebar')}</div>
            {item(true, FolderTree, t('ui.cli-monitor.group-by-project'), 'group-by-workspace')}
            {item(false, List, t('ui.cli-monitor.merged-list'), 'merged-list')}
          </div>
        </AnchoredPopover>
      )}
    </span>
  );
};
