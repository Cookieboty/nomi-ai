/**
 * 对话旁的标签区：子任务（委派的编程助手、进程内子代理、后台 Nomi）和打开的文件共用一块、一排标签。
 * - 点「查看」开一个子任务标签（已开着就切过去），可以同时开好几个，切走的只隐藏、状态都在；
 * - 双击任意标签铺满整个对话区，主会话变成第一个标签（不能关）；再双击 / Esc / 右上角按钮回到分栏；
 * - 文件预览（预览区的文件 / Diff 标签）也在这一排，双击一样铺满。
 * 状态在 SubagentPaneContext（按会话各记一份），文件标签来自 App 的 useResourcePreview。
 * 设计见 docs/design/side-tabs-workspace.md。
 */
import { Icon, IconButton, t } from '@nomi-ai/ui';
import {
  Bot,
  FileText,
  GitCompareArrows,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useSubagentPane, type SideTabMeta } from '../../contexts/SubagentPaneContext';
import type { EmbeddedPreviewProps } from '../../hooks/useResourcePreview';
import { isMac } from '../../services/shortcuts';
import type { ConvMessage } from '../../types/conversation';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { isImeComposing, shouldIgnoreEscape } from '../../utils/keyboard';
import { basename, resourceTarget } from '../../utils/resourceLinks';
import {
  cycleTabKey,
  FILES_SIDE_TAB,
  fileTabKey,
  isMaximized,
  MAIN_SIDE_TAB,
  sideTabItems,
  type SideTabItem,
  type SubagentTarget,
} from '../../utils/sideTabs';
import { EndpointIcon } from '../EndpointIcon';
import type { PreviewEntry, PreviewTabsControl } from '../ResourcePreview/ResourcePreview';
import { CenterChangesHost } from '../SessionWorkspace';
import { SubagentPane, type SubagentPaneActions } from '../SubagentPane';

import styles from './SideWorkspace.module.css';

/** 预览区的文件标签（App 的 useResourcePreview） */
export interface SideFiles {
  entries: readonly PreviewEntry[];
  activeKey: string;
  render: (p: EmbeddedPreviewProps) => React.ReactNode;
}

const fileLabel = (entry: PreviewEntry) =>
  basename(entry.diff?.path ?? resourceTarget(entry.href)?.path ?? entry.href);

/**
 * 标签区的状态和操作（App 里用一次，标签栏和主体共用）：当前是哪个标签、是否铺满、切换 / 关闭 / 双击。
 * 文件标签的切换和关闭交给预览区（先存草稿等），经 control 句柄。
 */
export function useSideWorkspace(files: SideFiles) {
  const pane = useSubagentPane();
  // 普通的可变对象（不是 ref）：随 model 往下传给预览区和标签栏
  const [control] = useState<{ current: PreviewTabsControl | null }>(() => ({ current: null }));
  const fileKeys = useMemo(() => files.entries.map((e) => e.key), [files.entries]);
  const hasFiles = fileKeys.length > 0;
  const tabs = pane?.tabs;
  const setFilesOpen = pane?.setFilesOpen;
  useEffect(() => {
    setFilesOpen?.(hasFiles);
  }, [hasFiles, setFilesOpen]);
  const items = useMemo(() => (tabs ? sideTabItems(tabs, fileKeys) : []), [tabs, fileKeys]);
  const maximized = !!tabs && isMaximized(tabs, hasFiles);
  const active = pane?.active ?? null;
  const open = !!tabs && (tabs.agents.length > 0 || hasFiles);
  /** 标签栏上高亮的那个：文件时是预览区当前的文件 */
  const stripActive =
    active === FILES_SIDE_TAB ? (files.activeKey ? fileTabKey(files.activeKey) : null) : active;
  const activate = useCallback(
    (item: SideTabItem) => {
      if (!pane) return;
      if (item.kind === 'file') {
        pane.activate(FILES_SIDE_TAB);
        if (item.entryKey) control.current?.activate(item.entryKey);
        return;
      }
      pane.activate(item.key);
    },
    [pane, control],
  );
  const close = useCallback(
    (item: SideTabItem) => {
      if (!pane || !item.closable) return;
      if (item.kind === 'file') {
        if (item.entryKey) control.current?.close([item.entryKey]);
        return;
      }
      pane.closeTab(item.key);
    },
    [pane, control],
  );
  const toggleMaximized = useCallback(
    (item?: SideTabItem) => {
      if (!pane) return;
      if (item?.kind === 'file') {
        if (item.entryKey) control.current?.activate(item.entryKey);
        pane.toggleMaximized(FILES_SIDE_TAB);
        return;
      }
      pane.toggleMaximized(item?.key);
    },
    [pane, control],
  );
  const restore = useCallback(() => pane?.restore(), [pane]);
  const setExpanded = useCallback(
    (next: boolean) => {
      if (!pane) return;
      if (next === maximized) return;
      if (next) pane.toggleMaximized(FILES_SIDE_TAB);
      else pane.restore();
    },
    [pane, maximized],
  );
  return {
    available: !!pane,
    open,
    maximized,
    active,
    stripActive,
    items,
    meta: pane?.meta ?? {},
    activate,
    close,
    toggleMaximized,
    restore,
    setExpanded,
    control,
    files,
  };
}

export type SideWorkspaceModel = ReturnType<typeof useSideWorkspace>;

/** 键盘：焦点在标签区（铺满时整个对话区）里时，Ctrl+Tab 轮换标签、⌘/Ctrl+W 关当前标签；铺满时 Esc 回到分栏 */
export function useSideWorkspaceKeys(model: SideWorkspaceModel) {
  const ref = useRef(model);
  useEffect(() => {
    ref.current = model;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = ref.current;
      if (!m.open || e.defaultPrevented || isImeComposing(e)) return;
      const target = e.target instanceof Element ? e.target : null;
      const inside = !!target?.closest(
        m.maximized ? '[data-side-max="true"]' : '[data-side-workspace]',
      );
      if (e.key === 'Tab' && e.ctrlKey && !e.altKey && !e.metaKey) {
        if (!inside) return;
        const next = cycleTabKey(m.items, m.stripActive, e.shiftKey ? -1 : 1);
        const item = m.items.find((i) => i.key === next);
        if (!item) return;
        e.preventDefault();
        m.activate(item);
        return;
      }
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
        if (!inside) return;
        const item = m.items.find((i) => i.key === m.stripActive);
        if (!item?.closable) return;
        e.preventDefault();
        m.close(item);
        return;
      }
      // 文件标签的 Esc 由预览区自己处理（铺满时先退出铺满）
      if (e.key === 'Escape' && m.maximized && m.active !== FILES_SIDE_TAB) {
        if (shouldIgnoreEscape(e)) return;
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        e.preventDefault();
        m.restore();
      }
    };
    // 捕获阶段：先于全局的 Ctrl+Tab（编程助手标签轮换）
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

const TabIcon: React.FC<{
  item: SideTabItem;
  backendOf: (t: SubagentTarget) => string | null;
  entry?: PreviewEntry;
}> = ({ item, backendOf, entry }) => {
  if (item.kind === 'main') return <Icon icon={MessageSquare} size={14} />;
  if (item.kind === 'file')
    return <Icon icon={entry?.diff ? GitCompareArrows : FileText} size={14} />;
  const backend = item.target ? backendOf(item.target) : null;
  if (backend && backend in ENDPOINT_NAME)
    return <EndpointIcon backend={backend as keyof typeof ENDPOINT_NAME} size={14} decorative />;
  return <Icon icon={Bot} size={14} />;
};

const fallbackName = (target: SubagentTarget | undefined, backend: string | null) => {
  if (target?.kind === 'harness' && backend && backend in ENDPOINT_NAME)
    return t(ENDPOINT_NAME[backend as keyof typeof ENDPOINT_NAME]);
  return t('ui.usage-tools.subagent');
};

/** 标签栏（参考浏览器 / Codex 的分栏标签）：图标 + 名字 + 状态点 + ×；末尾是「+」和铺满 / 还原 */
export const SideTabStrip: React.FC<{
  model: SideWorkspaceModel;
  onBrowseFiles?: () => void;
  onShowAgents?: () => void;
}> = ({ model, onBrowseFiles, onShowAgents }) => {
  const harness = useHarnessTabs();
  const backendOf = useCallback(
    (target: SubagentTarget): string | null => {
      if (target.kind === 'nomi-task') return 'nomi';
      if (target.kind === 'harness')
        return harness.state?.tabs.find((x) => x.id === target.tabId)?.backend ?? null;
      return null;
    },
    [harness.state?.tabs],
  );
  const entryOf = (item: SideTabItem) =>
    item.entryKey ? model.files.entries.find((e) => e.key === item.entryKey) : undefined;
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  // 当前标签被挤到可见范围外（标签多、这一栏窄）时滚过去
  const current = model.stripActive;
  useEffect(() => {
    if (!current) return;
    const el = Array.from(
      stripRef.current?.querySelectorAll<HTMLElement>('[data-side-tab-key]') ?? [],
    ).find((x) => x.dataset.sideTabKey === current);
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current]);
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(false);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [menu]);
  const label = (item: SideTabItem): string => {
    if (item.kind === 'main') return t('ui.session-workspace.side-tab-main');
    if (item.kind === 'file') {
      const entry = entryOf(item);
      return entry ? fileLabel(entry) : '';
    }
    const meta: SideTabMeta | undefined = model.meta[item.key];
    return meta?.name || fallbackName(item.target, item.target ? backendOf(item.target) : null);
  };
  return (
    <div className={styles.strip} data-testid="side-tab-strip">
      <div
        ref={stripRef}
        className={styles.tabs}
        role="tablist"
        aria-label={t('ui.session-workspace.side-tabs-label')}
      >
        {model.items.map((item) => {
          const selected = item.key === model.stripActive;
          const state = item.kind === 'agent' ? model.meta[item.key]?.state : undefined;
          const name = label(item);
          return (
            <div
              key={item.key}
              className={styles.tab}
              data-active={selected || undefined}
              data-kind={item.kind}
              data-testid="side-tab"
              data-side-tab-key={item.key}
              onContextMenu={
                item.kind === 'file' && item.entryKey
                  ? (event) => {
                      event.preventDefault();
                      const trigger =
                        event.currentTarget.querySelector<HTMLButtonElement>('[role="tab"]')!;
                      model.control.current?.openMenu({
                        key: item.entryKey!,
                        x: event.clientX,
                        y: event.clientY,
                        trigger,
                      });
                    }
                  : undefined
              }
            >
              <button
                type="button"
                role="tab"
                className={styles.tabMain}
                aria-selected={selected}
                onClick={() => model.activate(item)}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  model.toggleMaximized(item);
                }}
                onMouseDown={(e) => {
                  // 中键关标签（和浏览器一样）
                  if (e.button === 1 && item.closable) {
                    e.preventDefault();
                    model.close(item);
                  }
                }}
              >
                <TabIcon item={item} backendOf={backendOf} entry={entryOf(item)} />
                <span className={styles.tabLabel}>{name}</span>
                {state && state !== 'idle' && (
                  <span
                    className={styles.dot}
                    data-state={state}
                    data-testid="side-tab-status"
                    aria-label={
                      state === 'waiting'
                        ? t('ui.session-workspace.needs-your-approval')
                        : t('ui.knowledge-local.running')
                    }
                  />
                )}
              </button>
              {item.closable && (
                <button
                  type="button"
                  className={styles.close}
                  aria-label={t('ui.session-workspace.side-tab-close', name)}
                  data-testid="side-tab-close"
                  onClick={() => model.close(item)}
                >
                  <Icon icon={X} size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {(onBrowseFiles || onShowAgents) && (
        <div className={styles.addWrap} ref={menuRef}>
          <IconButton
            size="sm"
            label={t('ui.session-workspace.side-tab-add')}
            icon={<Icon icon={Plus} size={14} />}
            onClick={() => setMenu((v) => !v)}
            aria-expanded={menu}
            aria-haspopup="menu"
            data-testid="side-tab-add"
          />
          {menu && (
            <div className={styles.menu} role="menu">
              {onShowAgents && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    onShowAgents();
                  }}
                >
                  <Icon icon={Bot} size={14} />
                  {t('ui.session-workspace.side-tab-agents')}
                </button>
              )}
              {onBrowseFiles && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    onBrowseFiles();
                  }}
                >
                  <Icon icon={FileText} size={14} />
                  {t('ui.session-workspace.side-tab-browse-files')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <IconButton
        size="sm"
        label={t(
          model.maximized
            ? 'ui.session-workspace.side-tab-restore'
            : 'ui.session-workspace.side-tab-maximize',
        )}
        icon={<Icon icon={model.maximized ? Minimize2 : Maximize2} size={14} />}
        onClick={() =>
          model.maximized
            ? model.restore()
            : model.toggleMaximized(model.items.find((i) => i.key === model.stripActive))
        }
        data-testid="side-tab-maximize"
      />
    </div>
  );
};

/**
 * 标签区主体：子任务面板（都挂着，只显示当前的）+ 文件预览（隐藏时不接管 Esc）。
 * 没有标签时退回原来的中栏挂载点（右栏的未提交 / 磁盘文件预览 portal 进来）。
 * showStrip：分栏时标签栏在这一栏顶上；铺满时由 App 画在整个对话区顶上。
 */
export const SideWorkspace: React.FC<{
  model: SideWorkspaceModel;
  messages: readonly ConvMessage[];
  cwd?: string | null;
  roots?: readonly string[] | null;
  actions?: SubagentPaneActions;
  showStrip: boolean;
  onBrowseFiles?: () => void;
  onShowAgents?: () => void;
}> = ({ model, messages, cwd, roots, actions, showStrip, onBrowseFiles, onShowAgents }) => {
  if (!model.open)
    return <CenterChangesHost messages={messages} cwd={cwd} roots={roots} mode="slot" />;
  const filesActive = model.active === FILES_SIDE_TAB;
  return (
    <section
      className={styles.workspace}
      data-testid="side-workspace"
      data-side-workspace=""
      data-active-kind={model.active === MAIN_SIDE_TAB ? 'main' : filesActive ? 'files' : 'agent'}
    >
      {showStrip && (
        <SideTabStrip model={model} onBrowseFiles={onBrowseFiles} onShowAgents={onShowAgents} />
      )}
      <div className={styles.body}>
        <SubagentPane columnMessages={messages} actions={actions} tabbed />
        {model.files.render({
          inactive: !filesActive,
          expanded: model.maximized,
          onExpanded: model.setExpanded,
          controlRef: model.control,
        })}
      </div>
    </section>
  );
};
