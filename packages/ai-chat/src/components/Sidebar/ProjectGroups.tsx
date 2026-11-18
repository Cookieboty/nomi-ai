import { t, Icon, useLocale, usePresence } from '@nomi-ai/ui';
import {
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconChevronUp as ChevronUp,
  IconDots as Ellipsis,
  IconFolder as Folder,
  IconFolderOpen as FolderOpen,
  IconFolders as FolderTree,
  IconList as List,
  IconPinned as Pinned,
  IconPlus as Plus,
  IconEdit as SquarePen,
} from '@tabler/icons-react';
import React, { useEffect, useRef, useState } from 'react';

import { useDelegatePresets, type RunnerPreset } from '../../services/delegateClient';
import { useGatewayState } from '../../services/nomiModel';
import { CONVERSATION_BACKENDS, type ConversationBackend } from '../../types/chat';
import { NewChatMenu } from '../NewChatMenu';

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
        running={c.tabId ? undefined : rows.runningIds?.has(c.id)}
        done={c.tabId ? undefined : rows.doneIds?.has(c.id)}
        onOpen={rows.open}
        onCtx={rows.onCtx}
        renaming={rows.renamingId === c.id}
        onRename={rows.onRename}
        onPinToggle={rows.onPinToggle}
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

/**
 * 侧栏「按项目」：每个项目一个可折叠的文件夹（跨 Nomi 与所有 CLI 全局共享，无论是否切换端筛选都列出来），
 * 默认显示最近 5 条，其余自己展开；项目行上的「…」编辑项目，「新建」在该项目里选端（或按当前筛选）开新会话；
 * 悬停项目头时在右侧弹出详情卡片。没有项目的会话列在下面的「其他对话」里。
 */
export const ProjectGroups: React.FC<{
  groups: readonly ProjectGroup[];
  rest: readonly Meta[];
  collapsed: readonly string[];
  onToggleCollapsed: (key: string, collapsed: boolean) => void;
  onNewIn: (group: ProjectGroup, backend?: ConversationBackend, preset?: RunnerPreset) => void;
  onEdit: (group: ProjectGroup) => void;
  activeId: string | undefined;
  /** 与平铺列表共用的行回调（items / current 不用） */
  rows: VirtualProps;
  /** 「项目」标题右侧：整理「…」+ 新建项目 */
  headerActions?: React.ReactNode;
  /** 开发模式「全部」视图下点击项目新建按钮弹出后端选择菜单，允许为同一项目选不同 CLI */
  canPickBackend?: boolean;
  /** 各 CLI 可执行文件探测结果，用于标记未安装项 */
  bins?: Record<string, string | null>;
  /** 悬停 / 离开项目头：el 为 null 时延迟收起详情卡片 */
  onProjectPeek?: (projectId: string, el: HTMLElement | null) => void;
  /** 立即收起项目悬停卡片（如点击编辑或打开新建菜单时） */
  onHideProjectPeek?: () => void;
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
  canPickBackend = false,
  bins,
  onProjectPeek,
  onHideProjectPeek,
}) => {
  useLocale();
  // 「展开显示」每次多显示一页，只在本次打开期间记住；折叠状态才持久化
  const paging = usePaging();
  const restKey = '\u0000recent';
  const restCount = paging.countOf(restKey, RECENT_PREVIEW);
  const [newFor, setNewFor] = useState<{ group: ProjectGroup; anchor: HTMLElement } | null>(null);
  const [prevCanPick, setPrevCanPick] = useState(canPickBackend);
  if (prevCanPick !== canPickBackend) {
    setPrevCanPick(canPickBackend);
    if (!canPickBackend && newFor) setNewFor(null);
  }
  const newMenuP = usePresence(canPickBackend ? newFor : null);
  const presets = useDelegatePresets(!!newMenuP.value);
  const gateway = useGatewayState();
  const newPopRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!newFor || !canPickBackend) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node;
      if (!newFor.anchor.contains(el) && !newPopRef.current?.contains(el)) setNewFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNewFor(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [newFor, canPickBackend]);

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
      {wsOpen && groups.length === 0 && (
        <div className={ws.wsEmpty} data-testid="projects-empty">
          {t('ui.cli-monitor.project-none-yet')}
        </div>
      )}
      {wsOpen &&
        groups.map((g) => {
          const isCollapsed = collapsed.includes(g.key);
          const count = paging.countOf(g.key, WORKSPACE_PREVIEW);
          const shown = g.items.slice(0, count);
          const name = g.project.name;
          const toggleLabel = isCollapsed
            ? t('ui.cli-monitor.expand-workspace', name)
            : t('ui.cli-monitor.collapse-workspace', name);
          const newLabel = t('ui.cli-monitor.new-chat-in-project', name);
          const editLabel = t('ui.cli-monitor.project-edit', name);
          const menuOpenHere = canPickBackend && newFor?.group.key === g.key;
          return (
            <div
              key={g.key}
              className={ws.wsGroup}
              role="group"
              aria-label={name}
              data-testid="workspace-group"
              data-project={g.key}
              data-pinned={g.pinnedAt ? true : undefined}
              data-missing={g.project.missing?.length ? true : undefined}
            >
              <div
                className={ws.wsHead}
                onMouseEnter={
                  onProjectPeek ? (e) => onProjectPeek(g.key, e.currentTarget) : undefined
                }
                onMouseLeave={onProjectPeek ? () => onProjectPeek(g.key, null) : undefined}
              >
                <button
                  type="button"
                  className={ws.wsToggle}
                  aria-expanded={!isCollapsed}
                  aria-label={toggleLabel}
                  onClick={() => onToggleCollapsed(g.key, !isCollapsed)}
                  data-testid="workspace-toggle"
                >
                  <Icon icon={isCollapsed ? Folder : FolderOpen} size={16} />
                  <span className={ws.wsLabel}>{name}</span>
                  {g.pinnedAt ? (
                    <span className={ws.wsPin} data-testid="project-pinned" aria-hidden>
                      <Icon icon={Pinned} size={12} />
                    </span>
                  ) : null}
                  {isCollapsed && g.items.length > 0 && (
                    <span className={styles.listCount}>{g.items.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={ws.wsNew}
                  aria-label={editLabel}
                  onClick={() => {
                    setNewFor(null);
                    onHideProjectPeek?.();
                    onEdit(g);
                  }}
                  data-testid="project-edit"
                >
                  <Icon icon={Ellipsis} size={14} />
                </button>
                <button
                  type="button"
                  className={ws.wsNew}
                  aria-label={newLabel}
                  aria-haspopup={canPickBackend ? 'menu' : undefined}
                  aria-expanded={canPickBackend ? menuOpenHere : undefined}
                  onClick={(e) => {
                    onHideProjectPeek?.();
                    if (!canPickBackend) {
                      onNewIn(g);
                      return;
                    }
                    const anchor = e.currentTarget;
                    setNewFor((cur) => (cur?.group.key === g.key ? null : { group: g, anchor }));
                  }}
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
      {newMenuP.value && (
        <AnchoredPopover anchor={newMenuP.value.anchor} popRef={newPopRef}>
          <NewChatMenu
            closing={newMenuP.closing}
            className={styles.newMenu}
            backends={CONVERSATION_BACKENDS}
            bins={bins ?? {}}
            strictBins
            lastBackend={newMenuP.value.group.items[0]?.backend}
            testId="workspace-new-chat-menu"
            presets={presets}
            gateway={gateway}
            onPickPreset={(p) => {
              const target = newMenuP.value!.group;
              setNewFor(null);
              onNewIn(target, p.cli, p);
            }}
            onPick={(b) => {
              const target = newMenuP.value!.group;
              setNewFor(null);
              onNewIn(target, b);
            }}
          />
        </AnchoredPopover>
      )}
      {/* 「其他对话」：不在任何项目里的会话；一个都没有时整个分区不显示 */}
      {rest.length > 0 && (
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
      )}
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
  const [btnEl, setBtnEl] = useState<HTMLButtonElement | null>(null);
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
        ref={setBtnEl}
        type="button"
        className={styles.headBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('ui.cli-monitor.organize-sidebar')}
        onClick={() => setOpen((v) => !v)}
        data-testid="organize-sidebar"
      >
        <Icon icon={Ellipsis} size={14} />
      </button>
      {menuP.value && (
        <AnchoredPopover anchor={btnEl} popRef={popRef}>
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

/** 「项目」标题右侧的「+」：新建项目（打开「创建项目」；建好后由侧栏在项目里开一个会话） */
export const NewProjectButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    type="button"
    className={styles.headBtn}
    onClick={onClick}
    aria-label={t('ui.cli-monitor.project-create-title')}
    data-testid="new-project"
  >
    <Icon icon={Plus} size={14} />
  </button>
);
