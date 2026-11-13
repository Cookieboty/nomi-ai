/**
 * 对话旁的标签区：子任务（委派的编程助手、进程内子代理、后台 Nomi）和打开的文件共用一块、一排标签。
 * - 点「查看」开一个子任务标签（已开着就切过去），可以同时开好几个，切走的只隐藏、状态都在；
 * - 双击任意标签铺满整个对话区，主会话变成第一个标签（不能关）；再双击 / Esc / 右上角按钮回到分栏；
 * - 文件预览（预览区的文件 / Diff 标签）也在这一排，双击一样铺满；
 * - 标签可以拖动排序；拖出窗口 / 右键「在新窗口打开」弹到独立窗口；铺满时可以「向右拆分」（左主会话、右标签）。
 * 状态在 SubagentPaneContext（按会话各记一份），文件标签来自 App 的 useResourcePreview。
 * 设计见 docs/design/side-tabs-workspace.md。
 */
import { t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useSubagentPane } from '../../contexts/SubagentPaneContext';
import type { EmbeddedPreviewProps } from '../../hooks/useResourcePreview';
import { detachedWindows } from '../../services/detachedWindows';
import { isMac } from '../../services/shortcuts';
import type { ConvMessage } from '../../types/conversation';
import { canDetachTarget, parseDetachedId, type DetachSpec } from '../../utils/detachedTabs';
import { isImeComposing, shouldIgnoreEscape } from '../../utils/keyboard';
import {
  cycleTabKey,
  FILES_SIDE_TAB,
  fileTabKey,
  isMaximized,
  isSplit,
  MAIN_SIDE_TAB,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  sideTabItems,
  type SideTabItem,
} from '../../utils/sideTabs';
import type { PreviewEntry, PreviewTabsControl } from '../ResourcePreview/ResourcePreview';
import { CenterChangesHost } from '../SessionWorkspace';
import { SubagentPane, type SubagentPaneActions } from '../SubagentPane';

import styles from './SideWorkspace.module.css';
import { SideTabStrip } from './TabStrip';

export { SideTabStrip };

/** 预览区的文件标签（App 的 useResourcePreview） */
export interface SideFiles {
  entries: readonly PreviewEntry[];
  activeKey: string;
  render: (p: EmbeddedPreviewProps) => React.ReactNode;
}

/**
 * 标签区的状态和操作（App 里用一次，标签栏和主体共用）：当前是哪个标签、是否铺满、切换 / 关闭 / 双击。
 * 文件标签的切换和关闭交给预览区（先存草稿等），经 control 句柄。
 */
export function useSideWorkspace(files: SideFiles) {
  const pane = useSubagentPane();
  // 普通的可变对象（不是 ref）：随 model 往下传给预览区和标签栏
  const [control] = useState<{ current: PreviewTabsControl | null }>(() => ({ current: null }));
  const detached = pane?.detached;
  // 弹到独立窗口的文件不在这一侧显示
  const fileKeys = useMemo(
    () =>
      files.entries
        .map((e) => e.key)
        .filter((k) => !detached?.size || !detached.has(fileTabKey(k))),
    [files.entries, detached],
  );
  const hasFiles = fileKeys.length > 0;
  const tabs = pane?.tabs;
  const setFilesOpen = pane?.setFilesOpen;
  useEffect(() => {
    setFilesOpen?.(hasFiles);
  }, [hasFiles, setFilesOpen]);
  const items = useMemo(() => (tabs ? sideTabItems(tabs, fileKeys) : []), [tabs, fileKeys]);
  const maximized = !!tabs && isMaximized(tabs, hasFiles);
  const split = !!tabs && isSplit(tabs, hasFiles);
  const splitRatio = tabs?.splitRatio ?? 0.5;
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
  const toggleSplit = useCallback(
    (item?: SideTabItem) => {
      if (!pane) return;
      if (item?.kind === 'file') {
        if (item.entryKey) control.current?.activate(item.entryKey);
        pane.toggleSplit(FILES_SIDE_TAB);
        return;
      }
      pane.toggleSplit(item?.key);
    },
    [pane, control],
  );
  const setSplitRatio = useCallback((r: number) => pane?.setSplitRatio(r), [pane]);
  const move = useCallback(
    (key: string, toIndex: number) => pane?.moveTab(items, key, toIndex),
    [pane, items],
  );
  const entryOf = useCallback(
    (item: SideTabItem) =>
      item.entryKey ? files.entries.find((e) => e.key === item.entryKey) : undefined,
    [files.entries],
  );
  const canDetach = useCallback(
    (item: SideTabItem) => {
      if (!detachedWindows.available()) return false;
      if (item.kind === 'agent') return !!item.target && canDetachTarget(item.target);
      if (item.kind === 'file') return !!entryOf(item) && !entryOf(item)!.diff;
      return false;
    },
    [entryOf],
  );
  const scope = pane?.scope ?? '';
  /** 弹到独立窗口：子任务这一侧先隐藏（窗口关掉后回来）；文件从这一侧移过去 */
  const detach = useCallback(
    (item: SideTabItem, title: string) => {
      if (!canDetach(item)) return;
      let spec: DetachSpec | null = null;
      if (item.kind === 'agent' && item.target)
        spec = { v: 1, kind: 'agent', scope, target: item.target, title };
      const entry = entryOf(item);
      if (item.kind === 'file' && entry)
        spec = {
          v: 1,
          kind: 'file',
          scope,
          key: item.key,
          href: entry.href,
          origin: { ...entry.scope },
          title,
        };
      if (!spec) return;
      void detachedWindows.detach(spec).then((ok) => {
        if (ok && item.kind === 'file' && item.entryKey) control.current?.close([item.entryKey]);
      });
    },
    [canDetach, entryOf, scope, control],
  );
  // 弹出窗口里「放回主窗口」：切到那个标签（标签回到标签栏由 detachedChanged 负责）
  const activateKey = pane?.activate;
  useEffect(
    () =>
      detachedWindows.onDocked((id) => {
        const p = parseDetachedId(id);
        if (p && p.scope === scope && !p.key.startsWith('file:')) activateKey?.(p.key);
      }),
    [scope, activateKey],
  );
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
    split,
    splitRatio,
    toggleSplit,
    setSplitRatio,
    move,
    canDetach,
    detach,
    entryOf,
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
        <SideTabStrip
          model={model}
          columnMessages={messages}
          onBrowseFiles={onBrowseFiles}
          onShowAgents={onShowAgents}
        />
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

/**
 * 拆分时主会话和右边标签之间的分割线：拖动改左右宽度（按整个对话区算比例），双击回到一半；
 * 键盘：←/→ 每次 5%。
 */
export const SideSplitHandle: React.FC<{
  ratio: number;
  onRatio: (ratio: number) => void;
}> = ({ ratio, onRatio }) => {
  const drag = useRef<{ left: number; width: number } | null>(null);
  return (
    <div
      className="side-split-splitter"
      data-testid="side-split-splitter"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('ui.session-workspace.side-split-handle')}
      aria-valuemin={Math.round(SPLIT_RATIO_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_RATIO_MAX * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      onPointerDown={(e) => {
        const box = e.currentTarget.parentElement?.getBoundingClientRect();
        if (!box || box.width <= 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { left: box.left, width: box.width };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) onRatio((e.clientX - d.left) / d.width);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={() => onRatio(0.5)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onRatio(ratio + (e.key === 'ArrowLeft' ? -0.05 : 0.05));
        }
      }}
    />
  );
};
